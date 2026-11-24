import { botAvatarOrDefault, type BotAvatar } from "@t3tools/contracts";
import { View } from "react-native";
import Svg, { Circle, Path, Polygon, Rect } from "react-native-svg";

const SCREEN = "#0f172a";
const FACE = "#eafff5";

function body(avatar: BotAvatar, color: string) {
  switch (avatar.shape) {
    case "rectangle":
      return <Rect x={1} y={4} width={30} height={24} rx={6} fill={color} />;
    case "square":
      return <Rect x={4} y={4} width={24} height={24} rx={4} fill={color} />;
    case "circle":
      return <Circle cx={16} cy={16} r={13} fill={color} />;
    case "hexagon":
      return <Polygon points="16,3 27,9.5 27,22.5 16,29 5,22.5 5,9.5" fill={color} />;
  }
}

function screen(avatar: BotAvatar) {
  switch (avatar.shape) {
    case "rectangle":
      return <Rect x={5} y={8} width={22} height={16} rx={3.5} fill={SCREEN} />;
    case "square":
      return <Rect x={8} y={8} width={16} height={16} rx={2.5} fill={SCREEN} />;
    case "circle":
      return <Circle cx={16} cy={16} r={9} fill={SCREEN} />;
    case "hexagon":
      return <Polygon points="16,6 24.6,10.9 24.6,21.1 16,26 7.4,21.1 7.4,10.9" fill={SCREEN} />;
  }
}

/** Static robot head; react-native-svg stands in for the web's canvas robot-heads. */
export function BotAvatarView(props: {
  readonly bot: {
    readonly id: string;
    readonly name?: string;
    readonly avatar?: BotAvatar | undefined;
    readonly enabled?: boolean;
  };
  readonly size: number;
}) {
  const { bot, size } = props;
  const avatar = botAvatarOrDefault(bot);
  return (
    <View
      accessible
      accessibilityLabel={bot.name ?? "bot"}
      style={{ width: size, height: size, opacity: bot.enabled === false ? 0.45 : 1 }}
    >
      <Svg width={size} height={size} viewBox="0 0 32 32">
        {body(avatar, avatar.color)}
        {screen(avatar)}
        <Path
          d="M10 15 l2.5 -3 l2.5 3 M17 15 l2.5 -3 l2.5 3"
          stroke={FACE}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <Path
          d="M13 19.5 q3 2.5 6 0"
          stroke={FACE}
          strokeWidth={1.7}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    </View>
  );
}
