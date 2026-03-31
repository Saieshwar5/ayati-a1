"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

const SUPPORTED_FILE_ACCEPT = [
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".csv",
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".html",
  ".htm",
].join(",");

interface ChatComposerProps {
  connected: boolean;
  isAwaitingReply: boolean;
  isUploading: boolean;
  onSend: (content: string, files: File[]) => Promise<boolean>;
}

export function ChatComposer({
  connected,
  isAwaitingReply,
  isUploading,
  onSend,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const trimmedDraft = draft.trim();
  const disabled = !connected || isAwaitingReply || isUploading;
  const canSubmit = trimmedDraft.length > 0 && !disabled;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [draft]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    const sent = await onSend(trimmedDraft, pendingFiles);
    if (sent) {
      setDraft("");
      setPendingFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    if (selected.length === 0) {
      return;
    }

    setPendingFiles((current) => [...current, ...selected]);
    event.target.value = "";
  }

  function handleRemoveFile(index: number) {
    setPendingFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const helperText = isUploading
    ? "Uploading attachment..."
    : isAwaitingReply
      ? "Ayati is replying..."
      : connected
        ? "Enter to send. Shift+Enter for a new line."
        : "Ayati is disconnected.";

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="overflow-hidden rounded-[22px] border-2 border-[color:var(--app-composer-border)] bg-white px-2 py-1 shadow-[0_14px_32px_rgba(15,23,42,0.08)] transition-shadow focus-within:shadow-[0_20px_36px_rgba(37,99,235,0.12)]">
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_FILE_ACCEPT}
          multiple
          onChange={handleFileSelection}
          className="hidden"
        />

        {pendingFiles.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pendingFiles.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${index}`}
                className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
              >
                <span className="max-w-[180px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveFile(index)}
                  disabled={disabled}
                  className="rounded-full text-slate-500 transition hover:text-slate-900 disabled:cursor-not-allowed"
                  aria-label={`Remove ${file.name}`}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title="Attach file"
            className="mb-1.5 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M12 7V17M7 12H17"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
          </button>

          <label className="sr-only" htmlFor="chat-input">
            Message Ayati
          </label>
          <textarea
            ref={textareaRef}
            id="chat-input"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Ayati..."
            className="min-h-[52px] max-h-[200px] flex-1 resize-none overflow-y-auto border-none bg-transparent px-3 py-3.5 text-[15px] leading-7 text-[color:var(--app-foreground)] outline-none placeholder:text-slate-400"
          />

          <button
            type="submit"
            disabled={!canSubmit}
            title="Send message"
            className="mb-1.5 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M4 12H20M20 12L13.5 5.5M20 12L13.5 18.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
          </button>
        </div>
      </div>

      <p className="mt-2 px-2 text-xs font-medium text-[color:var(--app-muted)]">
        {helperText}
      </p>
    </form>
  );
}
