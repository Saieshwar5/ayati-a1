import type { ConnectionState } from "@/lib/chat/types";

interface ChatHeaderProps {
  connectionState: ConnectionState;
}

const STATUS_LABELS: Record<ConnectionState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
};

const STATUS_STYLES: Record<ConnectionState, string> = {
  connected: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  connecting: "bg-amber-50 text-amber-700 ring-amber-200",
  disconnected: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function ChatHeader({ connectionState }: ChatHeaderProps) {
  return (
    <header className="border-b border-[color:var(--app-border)] bg-white/70 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[color:var(--app-muted)]">
            Ayati
          </p>
          <h1 className="text-lg font-semibold tracking-tight text-[color:var(--app-foreground)] sm:text-xl">
            Chat
          </h1>
        </div>

        <div
          className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium ring-1 ${STATUS_STYLES[connectionState]}`}
        >
          <span className="h-2 w-2 rounded-full bg-current" />
          {STATUS_LABELS[connectionState]}
        </div>
      </div>
    </header>
  );
}
