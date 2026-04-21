/**
 * iRamFlow SVG logo component.
 * Renders "iRam" in bold + "Flow" in lighter weight with a clean return arrow.
 * Uses the iRam brand green #7CC042.
 */

interface LogoProps {
  size?: number;
  className?: string;
  /** When true, renders white text (for dark backgrounds like sidebar/login header) */
  light?: boolean;
}

export default function Logo({ size = 40, className = '', light = false }: LogoProps) {
  const scale = size / 40;
  const w = Math.round(120 * scale);
  const h = Math.round(40 * scale);

  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 120 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* "iRam" — bold */}
      <text
        x="2"
        y="24"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="22"
        fontWeight="800"
        letterSpacing="-0.5"
        fill={light ? '#ffffff' : '#32373C'}
      >
        <tspan>i</tspan>
        <tspan fill="#7CC042">R</tspan>
        <tspan>am</tspan>
      </text>

      {/* "Flow" — lighter weight */}
      <text
        x="64"
        y="24"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="22"
        fontWeight="300"
        letterSpacing="-0.3"
        fill={light ? 'rgba(255,255,255,0.85)' : '#6B7280'}
      >
        Flow
      </text>
    </svg>
  );
}
