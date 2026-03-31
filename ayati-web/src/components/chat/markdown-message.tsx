import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  content: string;
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({
    href,
    ...props
  }: ComponentProps<"a">) => (
    <a
      {...props}
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    />
  ),
};

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        disallowedElements={["img", "input"]}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
