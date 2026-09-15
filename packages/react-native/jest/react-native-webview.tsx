/**
 * Jest stand-in for `react-native-webview` (mapped in jest.config.js).
 * Records every `postMessage` and exposes the latest props so tests can emit
 * engine messages through `onMessage`.
 */

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { View } from 'react-native';

export interface FakeWebViewInstance {
  /** Raw strings passed to `postMessage`, in order. */
  posted: string[];
  /** Latest props. */
  props: Record<string, unknown>;
  reloads: number;
  mounted: boolean;
}

/** Every mounted fake WebView, in mount order. */
export const webViewInstances: FakeWebViewInstance[] = [];

const WebView = forwardRef<unknown, Record<string, unknown>>(function FakeWebView(props, ref) {
  const instance = useRef<FakeWebViewInstance>({ posted: [], props, reloads: 0, mounted: true }).current;
  instance.props = props;
  useLayoutEffect(() => {
    instance.mounted = true;
    webViewInstances.push(instance);
    return () => {
      instance.mounted = false;
    };
  }, [instance]);
  useImperativeHandle(ref, () => ({
    postMessage: (data: string) => {
      instance.posted.push(data);
    },
    injectJavaScript: () => {},
    reload: () => {
      instance.reloads += 1;
    },
  }));
  return <View testID={(props.testID as string | undefined) ?? 'fake-webview'} />;
});

export { WebView };
export default WebView;
