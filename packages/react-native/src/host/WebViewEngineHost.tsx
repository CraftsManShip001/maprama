/**
 * v1 engine host: runs `@maprama/engine-web` inside `react-native-webview`.
 *
 * Wire format (see `@maprama/engine-web` `createWebViewTransport`): commands are
 * delivered with `WebView.postMessage(encodeCommand(...))`, which the page
 * receives as a `message` event; the engine answers with
 * `window.ReactNativeWebView.postMessage(encodeEvent(...))`, which arrives in
 * `onMessage`.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet } from 'react-native';
import WebView from 'react-native-webview';
import { ENGINE_HTML } from '@maprama/engine-web/engine-html';
import { createMessageChannelHost, type EngineHostComponentProps, type MessageChannelHost } from './EngineHost';

/** Imperative WebView methods used by the host. */
interface WebViewHandle {
  postMessage(data: string): void;
  reload(): void;
}

const SOURCE = { html: ENGINE_HTML };

/**
 * Navigation origins the engine WebView accepts. The engine is an inline
 * document (`source={{ html }}`), which platforms report as `about:blank`
 * (always allowed by react-native-webview) or as a `data:` URL; the engine
 * itself never navigates. react-native-webview refuses any other navigation
 * before `onShouldStartLoadWithRequest` and hands it to `Linking`.
 * `originWhitelist` applies to navigations only, not to resource loads (world
 * JSON, glTF models), so it can be this narrow.
 */
const ORIGIN_WHITELIST = ['about:blank', 'about:srcdoc', 'data:*'];

/**
 * @internal Navigation guard of the engine WebView. Allows only the inline engine
 * document: `about:blank` / `about:srcdoc`, and `data:` until the first document
 * finished loading. http(s) links open in the system browser; everything else
 * (file:, javascript:, custom schemes, later data: pages) is refused. This keeps a
 * foreign page from replacing the engine and forging events such as `drop:collect`.
 */
export function shouldStartEngineLoad(url: string, initialDocumentLoaded: boolean, openURL: (url: string) => unknown): boolean {
  if (url.startsWith('about:blank') || url.startsWith('about:srcdoc')) return true;
  if (/^data:/i.test(url)) return !initialDocumentLoaded;
  if (/^https?:\/\//i.test(url)) {
    Promise.resolve()
      .then(() => openURL(url))
      .catch(() => {});
  }
  return false;
}

/** Renders the web engine in a transparent, non-scrolling WebView. */
export function WebViewEngineHost({ style, onHost, onHostError, options }: EngineHostComponentProps) {
  const webRef = useRef<WebViewHandle | null>(null);
  const channelRef = useRef<MessageChannelHost | null>(null);
  const callbacks = useRef({ onHost, onHostError });
  callbacks.current = { onHost, onHostError };
  // Bumped to re-create the WebView after the Android render process died.
  const [generation, setGeneration] = useState(0);
  // Whether the inline engine document of the current WebView finished loading.
  const documentLoaded = useRef(false);

  useEffect(() => {
    documentLoaded.current = false;
    const channel = createMessageChannelHost('web', (data) => webRef.current?.postMessage(data));
    channelRef.current = channel;
    callbacks.current.onHost(channel.host);
    return () => {
      channel.host.destroy();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [generation]);

  const onMessage = useCallback((event: { nativeEvent: { data: unknown } }) => {
    const error = channelRef.current?.receive(event.nativeEvent.data);
    if (error) callbacks.current.onHostError({ code: 'invalid_message', message: error, fatal: false });
  }, []);

  const onContentProcessDidTerminate = useCallback(() => {
    callbacks.current.onHostError({ code: 'host_crashed', message: 'WebView content process terminated; reloading', fatal: false });
    documentLoaded.current = false;
    webRef.current?.reload();
  }, []);

  const onLoadEnd = useCallback(() => {
    documentLoaded.current = true;
  }, []);

  const onShouldStartLoadWithRequest = useCallback(
    (request: { url?: string }) =>
      shouldStartEngineLoad(request.url ?? '', documentLoaded.current, (url) => Linking.openURL(url)),
    [],
  );

  const onRenderProcessGone = useCallback(() => {
    callbacks.current.onHostError({ code: 'host_crashed', message: 'WebView render process gone; re-creating', fatal: false });
    setGeneration((g) => g + 1);
  }, []);

  const onError = useCallback((event: { nativeEvent: { description?: string } }) => {
    callbacks.current.onHostError({
      code: 'host_load_failed',
      message: `WebView failed to load the engine: ${event.nativeEvent.description ?? 'unknown error'}`,
      fatal: true,
    });
  }, []);

  return (
    <WebView
      key={generation}
      ref={webRef as never}
      testID={options.testID}
      style={[styles.webview, style]}
      containerStyle={styles.container}
      source={SOURCE}
      originWhitelist={ORIGIN_WHITELIST}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      bounces={false}
      scrollEnabled={false}
      overScrollMode="never"
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      setSupportMultipleWindows={false}
      // The inline engine loads nothing from file:// URLs.
      allowFileAccess={false}
      // Mixed-content rules apply to secure (https) pages; the inline document is not one, so this blocks nothing the engine loads.
      mixedContentMode="never"
      geolocationEnabled={options.geolocationEnabled === true}
      webviewDebuggingEnabled={typeof __DEV__ !== 'undefined' && __DEV__}
      androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      onLoadEnd={onLoadEnd}
      onMessage={onMessage}
      onContentProcessDidTerminate={onContentProcessDidTerminate}
      onRenderProcessGone={onRenderProcessGone}
      onError={onError}
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: 'transparent' },
  container: { flex: 1, backgroundColor: 'transparent' },
});
