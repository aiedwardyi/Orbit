export function OrbitMark({ size = 76 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label="Orbit"
      className="drop-shadow-[0_14px_32px_rgba(0,0,0,0.45)]"
    >
      <rect x="12" y="10.5" width="71.5" height="72.5" rx="15" fill="#303446" />
      <ellipse
        cx="47.9"
        cy="46.8"
        rx="32.8"
        ry="13.6"
        transform="rotate(-20 47.9 46.8)"
        fill="none"
        stroke="#a6d189"
        strokeWidth="5.6"
      />
      <g transform="rotate(-8 47.8 47.3)">
        <rect x="26.2" y="27.2" width="43.1" height="40.3" rx="13.1" fill="#fdf6e4" />
        <circle cx="40.8" cy="43.6" r="2.2" fill="#2b2e36" />
        <circle cx="55.1" cy="43.6" r="2.2" fill="#2b2e36" />
      </g>
      <path
        d="M 78.5 40.6 A 32.8 13.6 -20 0 1 52.6 59.6 A 32.8 13.6 -20 0 1 20.5 61.7"
        fill="none"
        stroke="#a6d189"
        strokeWidth="5.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
