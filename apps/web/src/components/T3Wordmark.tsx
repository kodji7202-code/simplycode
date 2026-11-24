import type { SVGProps } from "react";

// SimplyCode wordmark: plain text so it inherits the caller's font and color.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 190 40" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="30"
        fill="currentColor"
        fontFamily="inherit"
        fontSize="32"
        fontWeight="700"
        letterSpacing="-0.5"
      >
        SimplyCode
      </text>
    </svg>
  );
}
