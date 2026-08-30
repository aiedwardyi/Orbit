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
      <defs>
        <linearGradient id="orbit-spectrum" x1="12" y1="84" x2="84" y2="12" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1688FF" />
          <stop offset="0.48" stopColor="#8B6CFF" />
          <stop offset="1" stopColor="#F45AA8" />
        </linearGradient>
        <radialGradient id="orbit-core" cx="0" cy="0" r="1" gradientTransform="translate(39 35) rotate(48) scale(31)">
          <stop stopColor="#FFFFFF" />
          <stop offset="0.7" stopColor="#DDE5F2" />
          <stop offset="1" stopColor="#8C96A8" />
        </radialGradient>
      </defs>
      <circle cx="48" cy="48" r="45" fill="#121216" stroke="#FFFFFF" strokeOpacity="0.1" strokeWidth="1.5" />
      <g className="orbit-mark-rings" fill="none" strokeLinecap="round">
        <ellipse cx="48" cy="48" rx="35" ry="16" transform="rotate(-24 48 48)" stroke="url(#orbit-spectrum)" strokeWidth="4" strokeDasharray="77 46" />
        <ellipse cx="48" cy="48" rx="35" ry="16" transform="rotate(66 48 48)" stroke="#FFFFFF" strokeOpacity="0.2" strokeWidth="2" strokeDasharray="54 68" />
      </g>
      <circle cx="48" cy="48" r="11" fill="url(#orbit-core)" />
      <circle cx="43" cy="43" r="3" fill="#FFFFFF" fillOpacity="0.9" />
      <circle cx="78" cy="40" r="3.5" fill="#F45AA8" />
      <circle cx="20" cy="61" r="3" fill="#1688FF" />
    </svg>
  );
}
