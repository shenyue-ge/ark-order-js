package com.onevcat.uniwebview;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.unity3d.player.UnityPlayer;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * Clean, zero-dependency, Android 16 (API 36) compatible implementation of
 * com.onevcat.uniwebview.UniWebViewInterface for Ark Order arm64 standalone.
 */
public class UniWebViewInterface {
    private static final String TAG = "UniWebView64";
    private static final ConcurrentHashMap<String, ViewHolder> sViews = new ConcurrentHashMap<String, ViewHolder>();
    private static volatile boolean sJsEnabled = true;

    private static final class ViewHolder {
        final String name;
        WebView webView;
        FrameLayout container;
        int x, y, width, height;
        int bgColor = Color.TRANSPARENT;
        float alpha = 1.0f;
        boolean visible = false;
        boolean openLinksExternal = false;
        boolean backButtonEnabled = true;
        boolean vScroll = true;
        boolean hScroll = false;
        boolean zoomEnabled = false;
        volatile String currentUrl = "";
        volatile boolean canGoBack = false;
        volatile boolean canGoForward = false;
        final Set<String> schemes = new HashSet<String>();
        final Map<String, String> headers = new HashMap<String, String>();

        ViewHolder(String n) {
            this.name = n;
            this.schemes.add("uniwebview");
        }
    }

    private static Activity getActivity() {
        return UnityPlayer.currentActivity;
    }

    private static void runUi(Runnable r) {
        Activity act = getActivity();
        if (act != null) {
            act.runOnUiThread(r);
        }
    }

    private static void sendResult(String name, String method, String identifier, String resultCode, String data) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("identifier", identifier == null ? "" : identifier);
            obj.put("resultCode", resultCode == null ? "200" : resultCode);
            obj.put("data", data == null ? "" : data);
            UnityPlayer.UnitySendMessage(name, method, obj.toString());
        } catch (Throwable t) {
            Log.e(TAG, "sendResult error", t);
        }
    }

    public static void prepare() {
        Log.i(TAG, "UniWebView64 prepared");
    }

    public static void setLogLevel(int level) {
    }

    public static void init(final String name, final int x, final int y, final int width, final int height) {
        final ViewHolder h = new ViewHolder(name);
        h.x = x;
        h.y = y;
        h.width = Math.max(width, 1);
        h.height = Math.max(height, 1);
        sViews.put(name, h);

        runUi(new Runnable() {
            @Override
            public void run() {
                try {
                    final Activity act = getActivity();
                    if (act == null) return;

                    WebView wv = new WebView(act);
                    WebSettings ws = wv.getSettings();
                    ws.setJavaScriptEnabled(sJsEnabled);
                    ws.setDomStorageEnabled(true);
                    ws.setDatabaseEnabled(true);
                    ws.setUseWideViewPort(true);
                    ws.setLoadWithOverviewMode(true);
                    ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
                    ws.setSupportZoom(h.zoomEnabled);
                    ws.setBuiltInZoomControls(h.zoomEnabled);
                    ws.setDisplayZoomControls(false);
                    if (Build.VERSION.SDK_INT >= 21) {
                        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                    }

                    wv.setBackgroundColor(h.bgColor);
                    wv.setVerticalScrollBarEnabled(h.vScroll);
                    wv.setHorizontalScrollBarEnabled(h.hScroll);
                    wv.setWebChromeClient(new WebChromeClient());
                    wv.setWebViewClient(new WebViewClient() {
                        @Override
                        public boolean shouldOverrideUrlLoading(WebView view, String url) {
                            return handleUrl(h, act, view, url);
                        }

                        @Override
                        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                            if (Build.VERSION.SDK_INT >= 21 && request != null && request.getUrl() != null) {
                                return handleUrl(h, act, view, request.getUrl().toString());
                            }
                            return false;
                        }

                        @Override
                        public void onPageStarted(WebView view, String url, Bitmap favicon) {
                            h.currentUrl = url == null ? "" : url;
                            h.canGoBack = view.canGoBack();
                            h.canGoForward = view.canGoForward();
                            UnityPlayer.UnitySendMessage(name, "PageStarted", h.currentUrl);
                        }

                        @Override
                        public void onPageFinished(WebView view, String url) {
                            h.currentUrl = url == null ? "" : url;
                            h.canGoBack = view.canGoBack();
                            h.canGoForward = view.canGoForward();
                            sendResult(name, "PageFinished", "", "200", h.currentUrl);
                        }

                        @Override
                        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                            sendResult(name, "PageErrorReceived", "", String.valueOf(errorCode), description);
                        }

                        @Override
                        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                            if (Build.VERSION.SDK_INT >= 23 && request != null && request.isForMainFrame()) {
                                sendResult(name, "PageErrorReceived", "",
                                        String.valueOf(error.getErrorCode()),
                                        String.valueOf(error.getDescription()));
                            }
                        }
                    });

                    wv.setOnKeyListener(new View.OnKeyListener() {
                        @Override
                        public boolean onKey(View v, int keyCode, KeyEvent event) {
                            if (event.getAction() == KeyEvent.ACTION_UP && keyCode == KeyEvent.KEYCODE_BACK) {
                                if (h.backButtonEnabled && h.webView != null && h.webView.canGoBack()) {
                                    h.webView.goBack();
                                    return true;
                                }
                                UnityPlayer.UnitySendMessage(name, "WebViewKeyDown", String.valueOf(keyCode));
                                return true;
                            }
                            return false;
                        }
                    });

                    FrameLayout container = new FrameLayout(act);
                    FrameLayout.LayoutParams wvLp = new FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                    container.addView(wv, wvLp);
                    container.setVisibility(View.GONE);

                    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(h.width, h.height);
                    lp.leftMargin = h.x;
                    lp.topMargin = h.y;

                    ViewGroup root = (ViewGroup) act.findViewById(android.R.id.content);
                    if (root != null) {
                        root.addView(container, lp);
                    }
                    h.webView = wv;
                    h.container = container;
                    Log.i(TAG, "init ok name=" + name + " rect=" + h.x + "," + h.y + " " + h.width + "x" + h.height);
                } catch (Throwable t) {
                    Log.e(TAG, "init failed", t);
                }
            }
        });
    }

    private static boolean handleUrl(ViewHolder h, Activity act, WebView view, String url) {
        if (url == null) return false;
        int idx = url.indexOf("://");
        if (idx > 0) {
            String scheme = url.substring(0, idx).toLowerCase();
            if (h.schemes.contains(scheme)) {
                UnityPlayer.UnitySendMessage(h.name, "MessageReceived", url);
                return true;
            }
        }
        if (h.openLinksExternal && (url.startsWith("http://") || url.startsWith("https://"))) {
            try {
                act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                return true;
            } catch (Throwable ignored) {
            }
        }
        return false;
    }

    public static void destroy(final String name) {
        final ViewHolder h = sViews.remove(name);
        if (h == null) return;
        runUi(new Runnable() {
            @Override
            public void run() {
                try {
                    if (h.container != null) {
                        ViewGroup parent = (ViewGroup) h.container.getParent();
                        if (parent != null) parent.removeView(h.container);
                    }
                    if (h.webView != null) {
                        h.webView.stopLoading();
                        h.webView.destroy();
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "destroy error", t);
                }
            }
        });
    }

    public static void load(final String name, final String url) {
        final ViewHolder h = sViews.get(name);
        if (h == null || url == null) return;
        h.currentUrl = url;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.webView != null) {
                    Log.i(TAG, "load " + name + " -> " + url);
                    if (h.headers.isEmpty()) {
                        h.webView.loadUrl(url);
                    } else {
                        h.webView.loadUrl(url, h.headers);
                    }
                }
            }
        });
    }

    public static void loadHTMLString(final String name, final String html, final String baseUrl) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.webView != null) {
                    h.webView.loadDataWithBaseURL(baseUrl, html == null ? "" : html, "text/html", "UTF-8", null);
                }
            }
        });
    }

    public static void reload(final String name) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.reload(); } });
    }

    public static void stop(final String name) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.stopLoading(); } });
    }

    public static String getUrl(String name) {
        ViewHolder h = sViews.get(name);
        return h != null ? h.currentUrl : "";
    }

    public static void setFrame(final String name, final int x, final int y, final int width, final int height) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        h.x = x;
        h.y = y;
        h.width = Math.max(width, 1);
        h.height = Math.max(height, 1);
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.container != null) {
                    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(h.width, h.height);
                    lp.leftMargin = h.x;
                    lp.topMargin = h.y;
                    h.container.setLayoutParams(lp);
                }
            }
        });
    }

    public static void setPosition(String name, int x, int y) {
        ViewHolder h = sViews.get(name);
        if (h != null) setFrame(name, x, y, h.width, h.height);
    }

    public static void setSize(String name, int width, int height) {
        ViewHolder h = sViews.get(name);
        if (h != null) setFrame(name, h.x, h.y, width, height);
    }

    public static boolean show(final String name, boolean fade, int edge, float duration, final String identifier) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return false;
        h.visible = true;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.container != null) {
                    h.container.setAlpha(h.alpha);
                    h.container.setVisibility(View.VISIBLE);
                    h.container.bringToFront();
                }
                if (identifier != null && identifier.length() > 0) {
                    UnityPlayer.UnitySendMessage(name, "ShowTransitionFinished", identifier);
                }
            }
        });
        return true;
    }

    public static boolean hide(final String name, boolean fade, int edge, float duration, final String identifier) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return false;
        h.visible = false;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.container != null) {
                    h.container.setVisibility(View.GONE);
                }
                if (identifier != null && identifier.length() > 0) {
                    UnityPlayer.UnitySendMessage(name, "HideTransitionFinished", identifier);
                }
            }
        });
        return true;
    }

    public static boolean animateTo(final String name, int x, int y, int width, int height, float duration, float delay, final String identifier) {
        setFrame(name, x, y, width, height);
        if (identifier != null && identifier.length() > 0) {
            UnityPlayer.UnitySendMessage(name, "AnimateToFinished", identifier);
        }
        return true;
    }

    public static void addJavaScript(String name, String jsString, String identifier) {
        evaluateJavaScript(name, jsString, identifier);
    }

    public static void evaluateJavaScript(final String name, final String jsString, final String identifier) {
        final ViewHolder h = sViews.get(name);
        if (h == null || jsString == null) return;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.webView != null && Build.VERSION.SDK_INT >= 19) {
                    h.webView.evaluateJavascript(jsString, new android.webkit.ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            sendResult(name, "EvalJavaScriptFinished", identifier, "0", value == null ? "" : value);
                        }
                    });
                }
            }
        });
    }

    public static void addUrlScheme(String name, String scheme) {
        ViewHolder h = sViews.get(name);
        if (h != null && scheme != null) h.schemes.add(scheme.toLowerCase());
    }

    public static void removeUrlScheme(String name, String scheme) {
        ViewHolder h = sViews.get(name);
        if (h != null && scheme != null) h.schemes.remove(scheme.toLowerCase());
    }

    public static void addSslExceptionDomain(String name, String domain) { }
    public static void removeSslExceptionDomain(String name, String domain) { }
    public static void addPermissionTrustDomain(String name, String domain) { }
    public static void removePermissionTrustDomain(String name, String domain) { }

    public static void setHeaderField(String name, String key, String value) {
        ViewHolder h = sViews.get(name);
        if (h == null || key == null) return;
        if (value == null) h.headers.remove(key);
        else h.headers.put(key, value);
    }

    public static void setUserAgent(final String name, final String ua) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.getSettings().setUserAgentString(ua); } });
    }

    public static String getUserAgent(String name) { return ""; }
    public static void setAllowAutoPlay(boolean flag) { }
    public static void setAllowJavaScriptOpenWindow(boolean flag) { }
    public static void setJavaScriptEnabled(boolean enabled) { sJsEnabled = enabled; }

    public static void cleanCache(final String name) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.clearCache(true); } });
    }

    public static void clearCookies() {
        runUi(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().removeAllCookies(null);
                } catch (Throwable ignored) { }
            }
        });
    }

    public static void setCookie(String url, String cookie) {
        try { CookieManager.getInstance().setCookie(url, cookie); } catch (Throwable ignored) { }
    }

    public static String getCookie(String url, String key) { return ""; }
    public static void clearHttpAuthUsernamePassword(String host, String realm) { }

    public static void setBackgroundColor(final String name, float r, float g, float b, float a) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        h.bgColor = Color.argb(Math.round(a * 255f), Math.round(r * 255f), Math.round(g * 255f), Math.round(b * 255f));
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.setBackgroundColor(h.bgColor); } });
    }

    public static void setWebViewAlpha(final String name, final float alpha) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        h.alpha = alpha;
        runUi(new Runnable() { @Override public void run() { if (h.container != null) h.container.setAlpha(alpha); } });
    }

    public static float getWebViewAlpha(String name) {
        ViewHolder h = sViews.get(name);
        return h != null ? h.alpha : 1.0f;
    }

    public static void setShowSpinnerWhileLoading(String name, boolean show) { }
    public static void setSpinnerText(String name, String text) { }

    public static boolean canGoBack(String name) {
        ViewHolder h = sViews.get(name);
        return h != null && h.canGoBack;
    }

    public static boolean canGoForward(String name) {
        ViewHolder h = sViews.get(name);
        return h != null && h.canGoForward;
    }

    public static void goBack(final String name) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.webView != null && h.webView.canGoBack()) {
                    h.webView.goBack();
                }
            }
        });
    }

    public static void goForward(final String name) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.webView != null && h.webView.canGoForward()) {
                    h.webView.goForward();
                }
            }
        });
    }

    public static void setOpenLinksInExternalBrowser(String name, boolean flag) {
        ViewHolder h = sViews.get(name);
        if (h != null) h.openLinksExternal = flag;
    }

    public static void setHorizontalScrollBarEnabled(final String name, final boolean enabled) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        h.hScroll = enabled;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.setHorizontalScrollBarEnabled(enabled); } });
    }

    public static void setVerticalScrollBarEnabled(final String name, final boolean enabled) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        h.vScroll = enabled;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.setVerticalScrollBarEnabled(enabled); } });
    }

    public static void setBouncesEnabled(String name, boolean enabled) { }

    public static void setZoomEnabled(final String name, final boolean enabled) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        h.zoomEnabled = enabled;
        runUi(new Runnable() {
            @Override
            public void run() {
                if (h.webView != null) {
                    h.webView.getSettings().setSupportZoom(enabled);
                    h.webView.getSettings().setBuiltInZoomControls(enabled);
                }
            }
        });
    }

    public static void setBackButtonEnabled(String name, boolean enabled) {
        ViewHolder h = sViews.get(name);
        if (h != null) h.backButtonEnabled = enabled;
    }

    public static void setUseWideViewPort(final String name, final boolean use) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.getSettings().setUseWideViewPort(use); } });
    }

    public static void setLoadWithOverviewMode(final String name, final boolean overview) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.getSettings().setLoadWithOverviewMode(overview); } });
    }

    public static void setImmersiveModeEnabled(String name, boolean enabled) { }
    public static void setWebContentsDebuggingEnabled(boolean enabled) { }
    public static void showWebViewDialog(String name, boolean show) { }
    public static void setAllowHTTPAuthPopUpWindow(String name, boolean flag) { }
    public static void print(String name) { }

    public static void scrollTo(final String name, final int x, final int y, boolean animated) {
        final ViewHolder h = sViews.get(name);
        if (h == null) return;
        runUi(new Runnable() { @Override public void run() { if (h.webView != null) h.webView.scrollTo(x, y); } });
    }

    public static void setCalloutEnabled(String name, boolean flag) { }
}
