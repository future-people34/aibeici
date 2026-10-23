package com.aibeici.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

/**
 * 爱背词 Android 外壳。
 *
 * 设计要点：
 * 1) 页面用 https://app.aibeici.local/ 这个虚拟域名打开，资源由 shouldInterceptRequest
 *    从 assets 里读 —— 这样页面是「安全上下文」，IndexedDB / localStorage 才可用
 *    （用 file:// 会拿不到 IndexedDB）。
 * 2) 浏览器里 CORS 会挡住直连大模型，所以 /api/llm 的 POST 走原生桥（AndroidHttp），
 *    由 Java 用 HttpURLConnection 转发，页面代码只多一个分支。
 * 3) Android WebView 对 speechSynthesis 支持很差，所以系统语音兜底走原生 TextToSpeech。
 */
public class MainActivity extends Activity {

    private static final String TAG = "AiBeiCi";
    private static final String HOST = "app.aibeici.local";
    private static final String BASE_URL = "https://" + HOST + "/";
    private static final String DEFAULT_API_BASE = "https://api.deepseek.com";

    private WebView webView;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private String pendingSpeech = null;
    /** 打包时写进 assets 的 Key，用户也可以在页面设置里覆盖 */
    private String bakedKey = "";
    private String bakedModel = "";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        bakedKey = readAssetText("apikey.txt");
        bakedModel = readAssetText("model.txt").trim();

        webView = new WebView(this);
        webView.setBackgroundColor(0xFFF5F2EA);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (BuildConfig.DEBUG_BUILD) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null || !HOST.equals(uri.getHost())) return null;
                String path = uri.getPath();
                if (path == null || path.isEmpty()) path = "/";

                if (path.startsWith("/api/llm")) {
                    if ("GET".equalsIgnoreCase(request.getMethod())) {
                        return jsonResponse(200, keyInfoJson());
                    }
                    // POST 由原生桥负责，这里只是兜底提示
                    return jsonResponse(501,
                            "{\"error\":\"POST /api/llm 在安卓端请走 AndroidHttp 桥\"}");
                }
                return assetResponse(path);
            }
        });

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        initTts();

        webView.loadUrl(BASE_URL);
    }

    /* ---------------- 资源与配置 ---------------- */

    private String readAssetText(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            String text = new String(bos.toByteArray(), StandardCharsets.UTF_8).trim();
            // 过滤注释行，支持 "DEEPSEEK_API_KEY=sk-xxx" 或直接一行 key
            for (String raw : text.split("\\r?\\n")) {
                String line = raw.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                int eq = line.indexOf('=');
                String value = eq >= 0 ? line.substring(eq + 1).trim() : line;
                if (value.length() >= 16 && value.matches("[\\x21-\\x7e]+")) return value;
            }
        } catch (IOException ignored) {
            // 没有就没有
        }
        return "";
    }

    private String keyInfoJson() {
        boolean has = !bakedKey.isEmpty();
        String source = has ? "内置" : "";
        return "{\"ok\":true,\"hasKey\":" + has + ",\"keySource\":\"" + source
                + "\",\"defaultModel\":\"" + (bakedModel.isEmpty() ? "deepseek-chat" : bakedModel) + "\"}";
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.US);
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest") || p.endsWith(".map")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private static boolean isTextual(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json")
                || mime.equals("application/manifest+json") || mime.equals("image/svg+xml");
    }

    private WebResourceResponse assetResponse(String path) {
        String rel = path.startsWith("/") ? path.substring(1) : path;
        if (rel.isEmpty()) rel = "index.html";
        if (rel.contains("..")) return textResponse(400, "bad path", "text/plain");

        try {
            InputStream in = getAssets().open("www/" + rel);
            String mime = mimeOf(rel);
            if (isTextual(mime)) return new WebResourceResponse(mime, "utf-8", in);
            return new WebResourceResponse(mime, null, in);
        } catch (IOException e) {
            // 没有扩展名的路径当作前端路由，回退到 index.html
            if (!rel.contains(".")) {
                try {
                    return new WebResourceResponse("text/html", "utf-8", getAssets().open("www/index.html"));
                } catch (IOException ignored) {
                    // fallthrough
                }
            }
            Log.w(TAG, "asset not found: " + rel);
            return textResponse(404, "not found: " + rel, "text/plain");
        }
    }

    private static WebResourceResponse textResponse(int code, String body, String mime) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse(mime, "utf-8", code, code == 200 ? "OK" : "ERR",
                new HashMap<String, String>(), new ByteArrayInputStream(bytes));
    }

    private static WebResourceResponse jsonResponse(int code, String json) {
        return textResponse(code, json, "application/json");
    }

    /* ---------------- 原生桥 ---------------- */

    public class Bridge {

        /** 页面调用：AndroidBridge.post(id, url, headersJson, body) */
        @JavascriptInterface
        public void post(final String id, final String url, final String headersJson, final String body) {
            new Thread(() -> {
                int status;
                String text;
                try {
                    JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
                    String key = headers.optString("x-api-key", "");
                    if (key.isEmpty()) key = bakedKey;
                    String base = headers.optString("x-base-url", "");
                    if (base.isEmpty()) base = DEFAULT_API_BASE;
                    base = base.replaceAll("/+$", "");

                    String target = url == null || url.isEmpty() ? "/api/llm" : url;
                    if (target.endsWith("/api/llm")) target = base + "/chat/completions";

                    if (key.isEmpty()) {
                        status = 401;
                        text = "{\"error\":\"没有 API Key。请在设置的「API Key」里填入，"
                                + "或打包前写进项目根目录 apikey.txt。\"}";
                    } else {
                        HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
                        conn.setRequestMethod("POST");
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(120000);
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                        conn.setRequestProperty("Authorization", "Bearer " + key);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                        status = conn.getResponseCode();
                        InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                        text = readAll(is);
                        conn.disconnect();
                    }
                } catch (Exception e) {
                    status = 599;
                    text = "{\"error\":\"调用大模型失败：" + escape(e.getMessage()) + "\"}";
                }
                deliver(id, status, text);
            }, "aibeici-http").start();
        }

        /** 原生 TTS（WebView 里 speechSynthesis 基本不可用） */
        @JavascriptInterface
        public void speak(String text, float rate) {
            if (text == null || text.trim().isEmpty()) return;
            if (!ttsReady || tts == null) {
                pendingSpeech = text.trim();
                return;
            }
            tts.setSpeechRate(rate > 0.1f && rate < 2f ? rate : 0.9f);
            tts.speak(text.trim(), TextToSpeech.QUEUE_FLUSH, null, "aibeici");
        }

        @JavascriptInterface
        public void stop() {
            if (tts != null) tts.stop();
        }

        /** 页面可以直接问：有没有内置 Key */
        @JavascriptInterface
        public boolean hasKey() {
            return !bakedKey.isEmpty();
        }
    }

    private void deliver(final String id, final int status, final String text) {
        final String js = "window.__androidHttpDone(" + JSONObject.quote(id) + "," + status + ","
                + JSONObject.quote(text) + ")";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String escape(String s) {
        if (s == null) return "未知错误";
        return s.replace("\\", "\\\\").replace("\"", "'").replace("\n", " ");
    }

    /* ---------------- TTS 初始化 ---------------- */

    private void initTts() {
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(Locale.US);
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                if (ttsReady && pendingSpeech != null) {
                    tts.speak(pendingSpeech, TextToSpeech.QUEUE_FLUSH, null, "aibeici");
                    pendingSpeech = null;
                }
            } else {
                Log.w(TAG, "TTS 初始化失败，将依赖在线发音");
            }
        });
    }

    /* ---------------- 生命周期与返回键 ---------------- */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 只用一行常量，避免为 debug/release 引额外的 BuildConfig 逻辑 */
    private static final class BuildConfig {
        static final boolean DEBUG_BUILD = true;
    }
}
