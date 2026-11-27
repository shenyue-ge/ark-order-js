using System;
using UnityEngine;
using UnityEngine.UI;

namespace PsLocalServer
{
    public class BootUi
    {
        private const string VERSION_TEXT = "V1.0.0-arm64";
        private const float POSTER_ALPHA = 0.40f;
        private static readonly string[] POSTER_NAMES = {
            "Loading", "Loading1", "Loading2", "Loading3", "Loading4", "Loading5",
            "Loading6", "Loading7", "Loading8", "Loading9", "Loading10", "Loading11", "Loading12",
        };

        private GameObject _canvasGo;
        private GameObject _root;
        private GameObject _driverGo;
        private Text _stage;
        private Text _pct;
        private RectTransform _fill;
        private Image _poster;
        private float _target = 0f;
        private float _shown = 0f;
        private bool _done;
        private float _fade = 1f;

        public Action OnGone;

        public void Build()
        {
            _canvasGo = new GameObject("PsBootCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(CanvasRenderer));
            var canvas = _canvasGo.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 30000;
            var scaler = _canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1280, 720);

            var camGo = new GameObject("PsBootRoot");
            camGo.transform.SetParent(_canvasGo.transform, false);
            _root = camGo;
            var rt = camGo.AddComponent<RectTransform>();
            Stretch(rt);

            var bg = camGo.AddComponent<Image>();
            bg.color = new Color(0.06f, 0.07f, 0.1f, 1f);

            var font = LoadFont();

            _stage = MakeText(camGo.transform, font, 26, new Vector2(0, 60), TextAnchor.MiddleCenter);
            _stage.text = "方舟指令 · 64位单机版";

            _pct = MakeText(camGo.transform, font, 20, new Vector2(0, -40), TextAnchor.MiddleCenter);

            var slotGo = new GameObject("slot", typeof(Image));
            slotGo.transform.SetParent(camGo.transform, false);
            var slotRt = slotGo.GetComponent<RectTransform>();
            slotRt.sizeDelta = new Vector2(640, 22);
            slotRt.anchoredPosition = new Vector2(0, 10);
            slotGo.GetComponent<Image>().color = new Color(1, 1, 1, 0.15f);

            var fillGo = new GameObject("fill", typeof(Image));
            fillGo.transform.SetParent(slotGo.transform, false);
            _fill = fillGo.GetComponent<RectTransform>();
            _fill.anchorMin = new Vector2(0f, 0.5f);
            _fill.anchorMax = new Vector2(0f, 0.5f);
            _fill.pivot = new Vector2(0f, 0.5f);
            _fill.sizeDelta = new Vector2(0, 22);
            _fill.anchoredPosition = Vector2.zero;
            var fimg = fillGo.GetComponent<Image>();
            fimg.color = new Color(0.4f, 0.75f, 1f, 1f);

            var ver = MakeText(camGo.transform, font, 14, new Vector2(0, -320), TextAnchor.MiddleCenter);
            ver.text = "Funky Star";

            var vver = MakeText(camGo.transform, font, 14, new Vector2(14, 8), TextAnchor.LowerLeft,
                Vector2.zero, Vector2.zero, Vector2.zero);
            vver.text = VERSION_TEXT;

            _driverGo = new GameObject("PsBootDriver");
            _driverGo.AddComponent<BootUiDriver>().ui = this;

            TryLoadPoster();
        }

        private Text MakeText(Transform parent, Font font, int size, Vector2 pos, TextAnchor anchor,
            Vector2? anchorMin = null, Vector2? anchorMax = null, Vector2? pivot = null)
        {
            var go = new GameObject("t" + size, typeof(Text));
            go.transform.SetParent(parent, false);
            var rt = go.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(900, 40);
            rt.anchoredPosition = pos;
            rt.anchorMin = anchorMin ?? new Vector2(0.5f, 0.5f);
            rt.anchorMax = anchorMax ?? new Vector2(0.5f, 0.5f);
            rt.pivot = pivot ?? new Vector2(0.5f, 0.5f);
            var t = go.GetComponent<Text>();
            t.font = font;
            t.fontSize = size;
            t.alignment = anchor;
            t.color = new Color(0.92f, 0.94f, 1f, 0.95f);
            t.horizontalOverflow = HorizontalWrapMode.Overflow;
            return t;
        }

        private void TryLoadPoster()
        {
            var name = POSTER_NAMES[UnityEngine.Random.Range(0, POSTER_NAMES.Length)];
            if (_driverGo != null)
                _driverGo.GetComponent<BootUiDriver>().StartPoster(this, name);
        }

        internal void ApplyPoster(byte[] ab, string name)
        {
            try
            {
                var bundle = AssetBundle.LoadFromMemory(ab);
                if (bundle == null) { Debug.LogError("[PsLocal] boot poster: bundle null (" + name + ")"); return; }
                try
                {
                    var texs = bundle.LoadAllAssets<Texture2D>();
                    if (texs == null || texs.Length == 0) { Debug.LogError("[PsLocal] boot poster: no texture (" + name + ")"); return; }
                    var tex = texs[0];
                    if (_root == null) return;
                    var go = new GameObject("poster", typeof(Image));
                    go.transform.SetParent(_root.transform, false);
                    go.transform.SetSiblingIndex(1);
                    Stretch(go.GetComponent<RectTransform>());
                    _poster = go.GetComponent<Image>();
                    _poster.sprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height),
                        new Vector2(0.5f, 0.5f), 100f);
                    _poster.color = new Color(1f, 1f, 1f, POSTER_ALPHA * (_done ? _fade : 1f));
                    Debug.Log("[PsLocal] boot poster: ok " + name + " " + tex.width + "x" + tex.height);
                }
                finally
                {
                    bundle.Unload(false);
                }
            }
            catch (Exception e)
            {
                try { Debug.LogError("[PsLocal] boot poster: " + e); } catch { }
            }
        }

        private static Font LoadFont()
        {
            Font f = null;
            try { f = Resources.GetBuiltinResource<Font>("Arial.ttf"); } catch { }
            if (f == null) try { f = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf"); } catch { }
            return f;
        }

        private static void Stretch(RectTransform rt)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = Vector2.zero;
            rt.offsetMax = Vector2.zero;
        }

        public void Set(string stage, double pct)
        {
            if (_done) return;
            if (_stage != null) _stage.text = stage;
            if (_pct != null) _pct.text = (pct * 100).ToString("F1") + "%";
            _target = (float)pct;
            if (_target >= 1f) _done = true;
        }

        internal void Tick()
        {
            if (_root == null) return;
            _shown += (_target - _shown) * 0.18f;
            if (_fill != null) _fill.sizeDelta = new Vector2(640f * Mathf.Clamp01(_shown), 22);
            if (_done)
            {
                _fade -= 0.03f;
                if (_fade <= 0f)
                {
                    Destroy();
                    var cb = OnGone;
                    OnGone = null;
                    if (cb != null) cb();
                }
                else if (_root != null)
                {
                    foreach (var img in _root.GetComponentsInChildren<Image>())
                        img.color = new Color(img.color.r, img.color.g, img.color.b,
                            (img == _poster) ? POSTER_ALPHA * _fade : _fade);
                    foreach (var txt in _root.GetComponentsInChildren<Text>())
                        txt.color = new Color(txt.color.r, txt.color.g, txt.color.b, _fade);
                }
            }
        }

        private void Destroy()
        {
            if (_driverGo != null) { UnityEngine.Object.Destroy(_driverGo); _driverGo = null; }
            if (_canvasGo != null) { UnityEngine.Object.Destroy(_canvasGo); _canvasGo = null; }
            _root = null;
            _fill = null;
        }

        private class BootUiDriver : MonoBehaviour
        {
            public BootUi ui;
            private void Update() { if (ui != null) ui.Tick(); }

            public void StartPoster(BootUi bootUi, string name)
            {
                StartCoroutine(LoadPoster(bootUi, name));
            }

            private System.Collections.IEnumerator LoadPoster(BootUi bootUi, string name)
            {
                var url = "jar:file://" + Application.dataPath + "!/assets/ui/1firstres/textures/"
                          + name.ToLower() + ".ab";
                var www = new WWW(url);
                yield return www;
                try
                {
                    if (!string.IsNullOrEmpty(www.error))
                    {
                        Debug.LogError("[PsLocal] boot poster: " + www.error + " (" + url + ")");
                        yield break;
                    }
                    bootUi.ApplyPoster(www.bytes, name);
                }
                finally
                {
                    www.Dispose();
                }
            }
        }
    }
}
