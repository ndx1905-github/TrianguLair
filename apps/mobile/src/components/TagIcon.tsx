import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { ICON_HALO } from '../pins/pinSvg';
import { iconPath } from '../theme/tags';

/**
 * A tag's badge: its color as a disc with its icon in white, outlined in dark
 * gray like on the pins (spec "Interface"). Fixed size: it is a pictogram,
 * not text.
 */
export function TagIcon({ icon, color, size = 32, muted = false }: { icon: string | null | undefined; color: string; size?: number; muted?: boolean }) {
  const d = iconPath(icon);
  const inner = Math.round(size * 0.62);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: '#FFFFFF',
        opacity: muted ? 0.55 : 1,
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 2,
        shadowOffset: { width: 0, height: 1 },
        elevation: 1,
      }}
      accessible={false}
    >
      <Svg width={inner} height={inner} viewBox="0 0 24 24">
        <Path d={d} fill="none" stroke={ICON_HALO} strokeWidth={3} strokeLinejoin="round" />
        <Path d={d} fill="#FFFFFF" />
      </Svg>
    </View>
  );
}
