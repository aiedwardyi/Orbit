export function OrbitMark({ size = 76 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="Orbit"
      className="drop-shadow-[0_14px_32px_rgba(0,0,0,0.45)]"
    >
      <rect x="26" y="26" width="972" height="972" rx="214" ry="214" fill="#2B1D1A" />
      <ellipse
        cx="512"
        cy="512"
        rx="427.7"
        ry="179.8"
        transform="rotate(-20 512 512)"
        fill="none"
        stroke="#FF9E64"
        strokeWidth="75.8"
      />
      <g transform="rotate(-8 512 512)">
        <rect x="103.8" y="142.1" width="816.5" height="759.3" rx="244.9" ry="244.9" fill="#F8E8D0" />
        <circle cx="373.2" cy="496.8" r="35" fill="#2B1D1A" />
        <circle cx="650.8" cy="496.8" r="35" fill="#2B1D1A" />
      </g>
      <path
        d="M 918.3 449.1 A 427.7 179.8 -20 0 1 276.8 673.8"
        fill="none"
        stroke="#FF9E64"
        strokeWidth="75.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
