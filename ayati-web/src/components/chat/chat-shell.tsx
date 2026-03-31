"use client";

import { useCallback, useState } from "react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatHeader } from "@/components/chat/chat-header";
import { MessageList } from "@/components/chat/message-list";
import { useChatWebSocket } from "@/hooks/use-chat-websocket";
import { uploadChatFiles } from "@/lib/chat/uploads";
import { useChatStore } from "@/stores/chat-store";

export function ChatShell() {
  const { sendMessage } = useChatWebSocket();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const connectionState = useChatStore((state) => state.connectionState);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const isAwaitingReply = useChatStore((state) => state.isAwaitingReply);
  const messages = useChatStore((state) => state.messages);

  const handleSend = useCallback(async (content: string, files: File[]): Promise<boolean> => {
    setUploadError(null);

    try {
      setIsUploading(files.length > 0);
      const attachments = await uploadChatFiles(files);
      return sendMessage(content, attachments);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed.");
      return false;
    } finally {
      setIsUploading(false);
    }
  }, [sendMessage]);

  return (
    <div className="flex min-h-screen flex-col">
      <ChatHeader connectionState={connectionState} />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 pb-56 pt-4 sm:px-6 sm:pb-64 sm:pt-6">
          <MessageList
            connectionState={connectionState}
            isAwaitingReply={isAwaitingReply}
            messages={messages}
          />
        </div>
      </main>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[color:var(--app-background)] via-[color:var(--app-background)]/94 to-transparent pt-10">
        <div className="pointer-events-auto mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 pb-4 sm:px-6 sm:pb-6">
          {uploadError ?? errorMessage ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm shadow-slate-950/5">
              {uploadError ?? errorMessage}
            </div>
          ) : null}

          <ChatComposer
            connected={connectionState === "connected"}
            isAwaitingReply={isAwaitingReply}
            isUploading={isUploading}
            onSend={handleSend}
          />
        </div>
      </div>
    </div>
  );
}
