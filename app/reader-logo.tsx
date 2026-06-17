type ReaderLogoProps = {
  className?: string;
};

export function ReaderLogo({ className = "" }: ReaderLogoProps) {
  const classNames = ["reader-logo", className].filter(Boolean).join(" ");

  return (
    <div className={classNames} aria-label="Reader">
      <svg
        className="reader-logo-mark"
        viewBox="0 0 56 56"
        role="img"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2" y="2" width="52" height="52" rx="16" fill="currentColor" />
        <path
          d="M20 14h16a4 4 0 0 1 4 4v25L28 36l-12 7V18a4 4 0 0 1 4-4Z"
          fill="var(--card)"
        />
      </svg>
      <span className="reader-logo-type" aria-hidden="true">
        <span className="reader-logo-name">Reader</span>
        <span className="reader-logo-line">HTML 阅读器</span>
      </span>
    </div>
  );
}
