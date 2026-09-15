import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

/** Map on top, scrollable control panel below. */
export function ScreenLayout({ map, children }: { map: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.screen}>
      <View style={styles.mapArea}>{map}</View>
      <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent} testID="panel">
        {children}
      </ScrollView>
    </View>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export interface ChipsProps<T extends string> {
  label?: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Each chip gets `testID="<prefix>-<option>"`. */
  testIDPrefix: string;
  labels?: Partial<Record<T, string>>;
}

/** Single-choice chip picker. */
export function Chips<T extends string>({ label, options, value, onChange, testIDPrefix, labels }: ChipsProps<T>) {
  return (
    <View style={styles.row}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.chips}>
        {options.map((option) => {
          const selected = option === value;
          return (
            <Pressable
              key={option}
              testID={`${testIDPrefix}-${option}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onChange(option)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{labels?.[option] ?? option}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Toggle({ label, value, onChange, testID }: { label: string; value: boolean; onChange: (v: boolean) => void; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={[styles.chip, value && styles.chipSelected, styles.toggle]}>
      <Text style={[styles.chipText, value && styles.chipTextSelected]}>
        {label}: {value ? 'on' : 'off'}
      </Text>
    </Pressable>
  );
}

export function Button({ title, onPress, testID, disabled }: { title: string; onPress: () => void; testID: string; disabled?: boolean }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.buttonDisabled]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttonRow}>{children}</View>;
}

export function Readout({ testID, children }: { testID: string; children: ReactNode }) {
  return (
    <Text testID={testID} style={styles.readout}>
      {children}
    </Text>
  );
}

/** Newest-first event log. */
export function EventLog({ lines, testID, empty = 'no events yet' }: { lines: string[]; testID: string; empty?: string }) {
  return (
    <View testID={testID} style={styles.log}>
      {lines.length === 0 ? <Text style={styles.logLine}>{empty}</Text> : null}
      {lines.slice(0, 8).map((line, i) => (
        <Text key={`${i}-${line}`} style={styles.logLine} numberOfLines={2}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** Appends to a newest-first log capped at 30 lines. */
export function useEventLog(): [string[], (line: string) => void] {
  const [lines, setLines] = useState<string[]>([]);
  const push = (line: string) => {
    const time = new Date().toLocaleTimeString();
    setLines((prev) => [`${time}  ${line}`, ...prev].slice(0, 30));
  };
  return [lines, push];
}

/** A message floating over the map that hides itself after `durationMs`. */
export function Toast({ message, testID, durationMs = 4000 }: { message: { text: string; key: number } | null; testID: string; durationMs?: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!message) return undefined;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs]);
  if (!message || !visible) return null;
  return (
    <View pointerEvents="none" style={styles.toastWrap}>
      <Text testID={testID} style={styles.toast}>
        {message.text}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' },
  mapArea: { flex: 1 },
  panel: { maxHeight: '45%', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#cbd5e1' },
  panelContent: { padding: 12, paddingBottom: 32 },
  section: { marginBottom: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { marginBottom: 6 },
  label: { fontSize: 12, color: '#475569', marginBottom: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: '#e2e8f0' },
  chipSelected: { backgroundColor: '#2f5bea' },
  chipText: { fontSize: 13, color: '#0f172a' },
  chipTextSelected: { color: 'white', fontWeight: '600' },
  toggle: { alignSelf: 'flex-start', marginBottom: 6 },
  button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0f172a' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: 'white', fontSize: 13, fontWeight: '600' },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  readout: { fontSize: 13, color: '#0f172a', fontVariant: ['tabular-nums'], marginBottom: 4 },
  log: { backgroundColor: '#0f172a', borderRadius: 8, padding: 8, minHeight: 48 },
  logLine: { color: '#e2e8f0', fontSize: 11, fontFamily: 'Menlo' },
  toastWrap: { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center' },
  toast: { backgroundColor: 'rgba(34,197,94,0.95)', color: 'white', fontWeight: '700', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, overflow: 'hidden' },
});
