// lucide-react v1.x dropped brand marks, so we inline the GitLab "tanuki"
// logo as an SVG so the GitLab settings tab keeps a recognizable icon in the
// sidebar and section headers. Single-path simplification of the official
// mark, drawn with currentColor so it inherits the surrounding text color.
export function GitLabMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 22.6 16.2 9.7H7.8L12 22.6Z" />
      <path d="M12 22.6 7.8 9.7H1.9L12 22.6Z" />
      <path d="M1.9 9.7.7 13.4c-.1.3 0 .7.3.9L12 22.6 1.9 9.7Z" />
      <path d="M1.9 9.7h5.9L5.3 2.1c-.1-.4-.7-.4-.8 0L1.9 9.7Z" />
      <path d="M12 22.6 16.2 9.7h5.9L12 22.6Z" />
      <path d="M22.1 9.7l1.2 3.7c.1.3 0 .7-.3.9L12 22.6 22.1 9.7Z" />
      <path d="M22.1 9.7h-5.9l2.5-7.6c.1-.4.7-.4.8 0l2.6 7.6Z" />
    </svg>
  );
}
