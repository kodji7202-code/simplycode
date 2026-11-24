import type { ColorValue } from "react-native";
import Svg, { Text } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedText = withUniwind(Text);

// SimplyCode wordmark: plain text so it inherits the caller's font and color.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 190 / 40;
  return (
    <Svg
      accessibilityLabel="SimplyCode"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 190 40"
    >
      <ThemedText
        x="0"
        y="32"
        fontSize="34"
        fontWeight="700"
        fill="currentColor"
        color={props.color}
        colorClassName={props.colorClassName}
      >
        SimplyCode
      </ThemedText>
    </Svg>
  );
}
