import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Box } from "ink";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Header } from "./components/header.js";
import { MessageList, type MessageListHandle } from "./components/message-list.js";
import { ChatInput } from "./components/chat-input.js";
import { StatusBar } from "./components/status-bar.js";
import { MAX_PROGRESS_LINES, ProgressPanel, progressPanelHeight } from "./components/progress-panel.js";
import { PathSuggestionList, pathSuggestionHeight } from "./components/path-suggestion-list.js";
import { useWebSocket } from "./hooks/use-websocket.js";
import { useMouseScroll } from "./hooks/use-mouse-scroll.js";
import type { MouseScrollEvent } from "./input/terminal-mouse.js";
import { DOC_COMMAND_HELP, parseCliCommand } from "./commands.js";
import {
  applyPathSuggestion,
  getPathSuggestions,
} from "./path-suggestions.js";
import {
  replacePathMentionsWithResolvedPaths,
  resolvePathMentions,
  stripPathMentions,
} from "./path-mentions.js";
import { detectAgentCliUiContext } from "./ui-context.js";
import type { ChatAttachment, ChatMessage, ServerMessage, WorkspaceEventName } from "./types.js";

const HEADER_HEIGHT = 3;
const STATUS_HEIGHT = 1;
const INPUT_HEIGHT = 5;
const RESERVED_ROWS = HEADER_HEIGHT + STATUS_HEIGHT + INPUT_HEIGHT;
const MIN_TERMINAL_ROWS = 10;
const MIN_MESSAGE_ROWS = 3;
const MIN_TERMINAL_COLUMNS = 20;

let nextId = 1;

function createMessage(
  role: ChatMessage["role"],
  content: string,
  kind: ChatMessage["kind"] = role === "user" ? "user" : "reply",
  attachments?: ChatAttachment[],
): ChatMessage {
  return {
    id: String(nextId++),
    role,
    kind,
    content,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    timestamp: Date.now(),
  };
}

export function App(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [dismissedSuggestionInput, setDismissedSuggestionInput] = useState<string | null>(null);
  const [terminalRows, setTerminalRows] = useState(
    Math.max(process.stdout.rows ?? 24, MIN_TERMINAL_ROWS),
  );
  const [terminalColumns, setTerminalColumns] = useState(
    Math.max(process.stdout.columns ?? 80, MIN_TERMINAL_COLUMNS),
  );
  const messageListRef = useRef<MessageListHandle>(null);
  const workspaceSessionId = useMemo(() => randomUUID(), []);

  useEffect(() => {
    const handleResize = (): void => {
      setTerminalRows(Math.max(process.stdout.rows ?? 24, MIN_TERMINAL_ROWS));
      setTerminalColumns(
        Math.max(process.stdout.columns ?? 80, MIN_TERMINAL_COLUMNS),
      );
    };

    process.stdout.on("resize", handleResize);

    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  const onMessage = useCallback((data: unknown) => {
    const msg = data as ServerMessage | { type?: string; content?: string; final?: boolean };
    if (msg.type === "reply" && typeof msg.content === "string") {
      const reply = createMessage("assistant", msg.content, "reply");
      setMessages((prev) => [...prev, reply]);
      setProgressLines([]);
      setIsLoading(false);
      return;
    }

    if (msg.type === "feedback" && typeof msg.content === "string") {
      const feedback = createMessage("assistant", msg.content, "feedback");
      setMessages((prev) => [...prev, feedback]);
      setProgressLines([]);
      setIsLoading(false);
      return;
    }

    if (msg.type === "notification" && typeof msg.content === "string") {
      const notification = createMessage("assistant", msg.content, "notification");
      setMessages((prev) => [...prev, notification]);
      if (msg.final === true) {
        setProgressLines([]);
        setIsLoading(false);
      }
      return;
    }

    if (msg.type === "progress" && typeof msg.content === "string") {
      const progressContent = msg.content;
      setProgressLines((prev) => [...prev, progressContent].slice(-MAX_PROGRESS_LINES));
      return;
    }

    if (msg.type === "error" && typeof msg.content === "string") {
      const reply = createMessage("assistant", msg.content, "error");
      setMessages((prev) => [...prev, reply]);
      setProgressLines([]);
      setIsLoading(false);
    }
  }, []);

  const { send, connected } = useWebSocket({ onMessage });

  const emitWorkspaceEvent = useCallback((event: WorkspaceEventName) => {
    void (async () => {
      const uiContext = await detectAgentCliUiContext();
      send({
        type: "workspace_event",
        event,
        workspaceSessionId,
        ...(uiContext ? { uiContext } : {}),
      });
    })();
  }, [send, workspaceSessionId]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    emitWorkspaceEvent("workspace_session_started");
  }, [connected, emitWorkspaceEvent]);

  useEffect(() => () => {
    send({
      type: "workspace_event",
      event: "workspace_session_ended",
      workspaceSessionId,
    });
  }, [send, workspaceSessionId]);

  const handleInputChange = useCallback((nextValue: string) => {
    const userComposed = !isLoading
      && inputValue !== nextValue
      && nextValue.trim().length > 0;
    if (userComposed) {
      emitWorkspaceEvent("cli_input_started");
    }
    setInputValue(nextValue);
  }, [emitWorkspaceEvent, inputValue, isLoading]);

  const pathSuggestions = useMemo(
    () => getPathSuggestions(inputValue, { limit: 6, roots: recentRoots }),
    [inputValue, recentRoots],
  );
  const suggestionsVisible = pathSuggestions.length > 0
    && !isLoading
    && dismissedSuggestionInput !== inputValue;

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [inputValue]);

  useEffect(() => {
    setSelectedSuggestionIndex((index) => {
      if (pathSuggestions.length === 0) {
        return 0;
      }
      return Math.min(index, pathSuggestions.length - 1);
    });
  }, [pathSuggestions.length]);

  const handleMouseScroll = useCallback((event: MouseScrollEvent) => {
    if (event.direction === "up") {
      messageListRef.current?.scrollByLines(-event.amount);
      return;
    }

    messageListRef.current?.scrollByLines(event.amount);
  }, []);

  useMouseScroll({
    enabled: process.env["AYATI_MOUSE_SCROLL"] === "1",
    onScroll: handleMouseScroll,
  });

  const rememberAttachmentRoots = useCallback((attachments: ChatAttachment[]) => {
    if (attachments.length === 0) {
      return;
    }

    setRecentRoots((prev) => {
      const merged = new Map(prev.map((root) => [root, root]));
      for (const attachment of attachments) {
        const root = attachment.kind === "directory"
          ? attachment.path
          : dirname(attachment.path);
        merged.delete(root);
        merged.set(root, root);
      }
      return [...merged.values()].slice(-8);
    });
  }, []);

  const submitChatMessage = useCallback((
    serverContent: string,
    displayContent: string,
    attachments: ChatAttachment[],
    displayAttachments: ChatAttachment[],
  ) => {
    const trimmedServerContent = serverContent.trim();
    const trimmedDisplayContent = displayContent.trim();
    if (!trimmedServerContent || !trimmedDisplayContent) return;

    const userMessage = createMessage("user", trimmedDisplayContent, "user", displayAttachments);
    setMessages((prev) => [...prev, userMessage]);

    setProgressLines([]);
    setIsLoading(true);
    void (async () => {
      const uiContext = await detectAgentCliUiContext();
      send({
        type: "workspace_event",
        event: "cli_message_submitted",
        workspaceSessionId,
        ...(uiContext ? { uiContext } : {}),
      });
      send({
        type: "chat",
        content: trimmedServerContent,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(uiContext ? { uiContext } : {}),
      });
    })();

    rememberAttachmentRoots(displayAttachments);
  }, [rememberAttachmentRoots, send, workspaceSessionId]);

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed.startsWith("/")) {
        handleCommand(trimmed, (content) => {
          setMessages((prev) => [...prev, createMessage("assistant", content)]);
        });
        setInputValue("");
        return;
      }

      if (isLoading) return;

      const resolvedMentions = resolvePathMentions(trimmed);
      if (resolvedMentions.missing.length > 0) {
        const lines = ["Could not find:"];
        for (const missing of resolvedMentions.missing) {
          lines.push(`- ${missing.path}`);
        }
        setMessages((prev) => [...prev, createMessage("assistant", lines.join("\n"), "error")]);
        return;
      }

      const mentionedAttachments = resolvedMentions.resolved.map((entry) => entry.attachment);
      const messageWithoutMentions = stripPathMentions(trimmed);
      const displayContent = messageWithoutMentions.length > 0
        ? messageWithoutMentions
        : attachmentOnlyMessage(mentionedAttachments);

      const contentWithResolvedPaths = replacePathMentionsWithResolvedPaths(trimmed, resolvedMentions.resolved);
      const contentForServer = appendDirectoryContext(
        messageWithoutMentions.length > 0 ? contentWithResolvedPaths : displayContent,
        mentionedAttachments,
      );
      const serverAttachments = toServerAttachments(mentionedAttachments);
      setInputValue("");
      submitChatMessage(
        contentForServer,
        displayContent,
        serverAttachments,
        mentionedAttachments,
      );
    },
    [isLoading, submitChatMessage],
  );

  const handleSuggestionUp = useCallback(() => {
    setSelectedSuggestionIndex((index) => {
      if (pathSuggestions.length === 0) return 0;
      return (index - 1 + pathSuggestions.length) % pathSuggestions.length;
    });
  }, [pathSuggestions.length]);

  const handleSuggestionDown = useCallback(() => {
    setSelectedSuggestionIndex((index) => {
      if (pathSuggestions.length === 0) return 0;
      return (index + 1) % pathSuggestions.length;
    });
  }, [pathSuggestions.length]);

  const handleAcceptSuggestion = useCallback((options?: { finalizeDirectory?: boolean }) => {
    const suggestion = pathSuggestions[selectedSuggestionIndex] ?? pathSuggestions[0];
    if (!suggestion) return;
    setInputValue((value) => applyPathSuggestion(value, suggestion, options));
  }, [pathSuggestions, selectedSuggestionIndex]);

  const handleDismissSuggestions = useCallback(() => {
    setDismissedSuggestionInput(inputValue);
  }, [inputValue]);

  const suggestionsHeight = suggestionsVisible ? pathSuggestionHeight(pathSuggestions) : 0;
  const progressHeight = progressPanelHeight(progressLines);
  const messageViewportHeight = Math.max(
    MIN_MESSAGE_ROWS,
    terminalRows - RESERVED_ROWS - suggestionsHeight - progressHeight,
  );

  return (
    <Box flexDirection="column" height={terminalRows}>
      <Header />
      <MessageList
        ref={messageListRef}
        messages={messages}
        height={messageViewportHeight}
        width={terminalColumns - 2}
        keyboardScrollEnabled={!suggestionsVisible}
      />
      <ProgressPanel
        lines={progressLines}
        width={terminalColumns}
      />
      <PathSuggestionList
        suggestions={pathSuggestions}
        selectedIndex={selectedSuggestionIndex}
        height={suggestionsHeight}
      />
      <StatusBar
        isLoading={isLoading}
        connected={connected}
      />
      <ChatInput
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        width={terminalColumns}
        height={INPUT_HEIGHT}
        suggestionsVisible={suggestionsVisible}
        onSuggestionUp={handleSuggestionUp}
        onSuggestionDown={handleSuggestionDown}
        onAcceptSuggestion={handleAcceptSuggestion}
        onDismissSuggestions={handleDismissSuggestions}
      />
    </Box>
  );
}

function handleCommand(command: string, pushAssistantMessage: (content: string) => void): void {
  const parsed = parseCliCommand(command);

  if (parsed.type === "clearDocs") {
    pushAssistantMessage("There is no separate attachment tray. Delete @path text from the input to remove attachments before sending.");
    return;
  }

  if (parsed.type === "invalid") {
    pushAssistantMessage(parsed.message);
    return;
  }

  pushAssistantMessage(`Unknown command. ${DOC_COMMAND_HELP}`);
}

function toServerAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments
    .filter((attachment) => attachment.kind !== "directory")
    .map((attachment) => ({
      source: "cli",
      path: attachment.path,
      ...(attachment.name ? { name: attachment.name } : {}),
    }));
}

function appendDirectoryContext(content: string, attachments: ChatAttachment[]): string {
  const trimmed = content.trim();
  const directories = attachments.filter((attachment) => (
    attachment.kind === "directory" && !trimmed.includes(attachment.path)
  ));
  if (directories.length === 0) {
    return trimmed;
  }

  const lines = [
    trimmed,
    "",
    "[selected local directories]",
    ...directories.map((directory) => `- ${directory.path}`),
  ];
  return lines.join("\n");
}

function attachmentOnlyMessage(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  return "Attached selected items.";
}
