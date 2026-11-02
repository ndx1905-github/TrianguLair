import { StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { pinSvg } from '../pins/pinSvg';
import { ICON_PATHS } from '../theme/icons';
import { PALETTE } from '../theme/tags';

const PINS = [
  { color: PALETTE.red, icon: ICON_PATHS.restaurant, x: 0, y: 26 },
  { color: PALETTE.blue, icon: ICON_PATHS.museum, x: 52, y: 0 },
  { color: PALETTE.green, icon: ICON_PATHS.park, x: 104, y: 26 },
];

/** Three pins in a triangle (decorative; pins never scale with the text size). */
export function Hero() {
  return (
    <View style={styles.box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {PINS.map((p, i) => (
        <View key={i} style={{ position: 'absolute', left: p.x, top: p.y }}>
          <SvgXml xml={pinSvg({ colors: [p.color], iconPath: p.icon, faded: false }, { width: 44, height: 57 })} width={44} height={57} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 148, height: 84, alignSelf: 'center', marginBottom: 8 },
});
