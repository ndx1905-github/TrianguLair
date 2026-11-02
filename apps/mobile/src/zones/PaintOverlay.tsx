import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

export interface ScreenPoint {
  x: number;
  y: number;
}

interface Props {
  /** Brush diameter, px. */
  thickness: number;
  eraser: boolean;
  color: string;
  /** A finished stroke, in px from the top-left of the overlay. */
  onStroke: (points: ScreenPoint[]) => void;
}

/** Minimum move (px) between two recorded points of a stroke. */
const STEP_PX = 3;

/**
 * Finger painting (spec "Zones" > Freehand drawing, by painting): covers the
 * map and captures the finger (or mouse) like a marker. The stroke being
 * drawn is shown here; finished strokes go to the screen, which merges them
 * into the zone shape drawn by the map.
 */
export function PaintOverlay({ thickness, eraser, color, onStroke }: Props) {
  const origin = useRef({ x: 0, y: 0 });
  const viewRef = useRef<View>(null);
  const [stroke, setStroke] = useState<ScreenPoint[]>([]);
  const current = useRef<ScreenPoint[]>([]);
  const cb = useRef(onStroke);
  cb.current = onStroke;

  const at = (e: { nativeEvent: { pageX: number; pageY: number } }): ScreenPoint => ({
    x: e.nativeEvent.pageX - origin.current.x,
    y: e.nativeEvent.pageY - origin.current.y,
  });

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        current.current = [at(e)];
        setStroke(current.current);
      },
      onPanResponderMove: (e) => {
        const p = at(e);
        const last = current.current[current.current.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < STEP_PX) return;
        current.current = [...current.current, p];
        setStroke(current.current);
      },
      onPanResponderRelease: () => {
        const done = current.current;
        current.current = [];
        setStroke([]);
        if (done.length) cb.current(done);
      },
      onPanResponderTerminate: () => {
        current.current = [];
        setStroke([]);
      },
    }),
  ).current;

  const onLayout = (_e: LayoutChangeEvent) => {
    viewRef.current?.measureInWindow((x, y) => {
      origin.current = { x, y };
    });
  };

  return (
    <View ref={viewRef} style={StyleSheet.absoluteFill} onLayout={onLayout} {...responder.panHandlers} testID="paint-overlay">
      {stroke.length > 0 && (
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Polyline
            points={(stroke.length === 1 ? [stroke[0]!, { x: stroke[0]!.x + 0.1, y: stroke[0]!.y }] : stroke)
              .map((p) => `${p.x},${p.y}`)
              .join(' ')}
            fill="none"
            stroke={eraser ? 'rgba(100,116,139,0.55)' : color}
            strokeOpacity={eraser ? 1 : 0.45}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      )}
    </View>
  );
}
