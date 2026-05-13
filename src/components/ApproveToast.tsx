interface ApproveToastProps {
  message: string;
}

export function ApproveToast({ message }: ApproveToastProps) {
  return (
    <div
      className="fixed bottom-12 right-6 font-sans rounded-md shadow-lg px-4 py-2 z-50"
      style={{
        background: "var(--color-success)",
        color: "white",
        fontSize: "13px",
        fontWeight: 500,
      }}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
