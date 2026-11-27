using System;
using System.IO;
using Assets.Plugins.Scripts;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.Rendering;
using UnityEngine.UI;

public static class BuildArm64
{
    public static void BuildBaseApk()
    {
        try
        {
            ConfigureExternalTools();
            ConfigureTagManager();
            ConfigureNativePlugins();
            ConfigureBuiltinResources();
            ConfigureAlwaysIncludedShaders();
            ConfigurePlayerSettings("方舟指令", "1.0.0-omega", 120000);

            string scenePath = CreateMainScene();
            string build64Dir = Path.GetFullPath(Path.Combine(Application.dataPath, "../.."));
            string outApk = Path.Combine(Path.Combine(build64Dir, "out64"), "fzzl_arm64_base.apk");
            Directory.CreateDirectory(Path.GetDirectoryName(outApk));

            Debug.Log("[BuildArm64] Starting BuildPipeline.BuildPlayer (BASE) -> " + outApk);
            string err = BuildPipeline.BuildPlayer(
                new string[] { scenePath },
                outApk,
                BuildTarget.Android,
                BuildOptions.None
            );
            if (!string.IsNullOrEmpty(err))
            {
                Debug.LogError("[BuildArm64] BUILD BASE FAILED: " + err);
                EditorApplication.Exit(1);
                return;
            }
            Debug.Log("[BuildArm64] BUILD BASE SUCCEEDED: " + outApk);
            EditorApplication.Exit(0);
        }
        catch (Exception ex)
        {
            Debug.LogError("[BuildArm64] EXCEPTION: " + ex);
            EditorApplication.Exit(2);
        }
    }

    private static void ConfigureExternalTools()
    {
        string sdk = Environment.GetEnvironmentVariable("FZZL_UNITY_ANDROID_SDK") ?? @"F:\ark64_tools\android_sdk_u2017";
        string ndk = Environment.GetEnvironmentVariable("FZZL_NDK_R13B") ?? @"F:\ark64_tools\android-ndk-r13b";
        string jdk = FindJdk8Dir();
        EditorPrefs.SetString("AndroidSdkRoot", sdk);
        EditorPrefs.SetString("AndroidNdkRoot", ndk);
        EditorPrefs.SetString("AndroidNdkRootR13b", ndk);
        EditorPrefs.SetString("JdkPath", jdk);
        Debug.Log(string.Format("[BuildArm64] Tools: SDK={0} NDK={1} JDK={2}", sdk, ndk, jdk));
    }

    private static string FindJdk8Dir()
    {
        string root = Environment.GetEnvironmentVariable("FZZL_JDK8") ?? @"F:\ark64_tools\jdk8";
        if (File.Exists(Path.Combine(root, @"bin\javac.exe"))) return root;
        foreach (string sub in Directory.GetDirectories(root))
        {
            if (File.Exists(Path.Combine(sub, @"bin\javac.exe"))) return sub;
        }
        throw new DirectoryNotFoundException("JDK 8 javac.exe not found under " + root);
    }

    private static void ConfigureTagManager()
    {
        UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset");
        if (assets == null || assets.Length == 0) return;
        SerializedObject so = new SerializedObject(assets[0]);

        string[] tags = new string[] { "JumpPoint", "PlotElement", "Map" };
        SerializedProperty tagsProp = so.FindProperty("tags");
        tagsProp.arraySize = tags.Length;
        for (int i = 0; i < tags.Length; i++)
            tagsProp.GetArrayElementAtIndex(i).stringValue = tags[i];

        SerializedProperty layersProp = so.FindProperty("layers");
        SetLayer(layersProp, 8, "MapLayer");
        SetLayer(layersProp, 9, "UnitLayer");
        SetLayer(layersProp, 10, "PlotLayer");
        SetLayer(layersProp, 11, "EffectLayer1");
        SetLayer(layersProp, 12, "EffectLayer2");
        SetLayer(layersProp, 30, "SceneTop");
        SetLayer(layersProp, 31, "Scene");

        SerializedProperty sortProp = so.FindProperty("m_SortingLayers");
        sortProp.arraySize = 3;
        SetSortingLayer(sortProp.GetArrayElementAtIndex(0), "Default", 0);
        SetSortingLayer(sortProp.GetArrayElementAtIndex(1), "Middle", 1550326527);
        SetSortingLayer(sortProp.GetArrayElementAtIndex(2), "Top", 647529133);

        so.ApplyModifiedPropertiesWithoutUndo();
        AssetDatabase.SaveAssets();
        Debug.Log("[BuildArm64] TagManager configured.");
    }

    private static void SetLayer(SerializedProperty layersProp, int idx, string name)
    {
        if (idx < layersProp.arraySize)
            layersProp.GetArrayElementAtIndex(idx).stringValue = name;
    }

    private static void SetSortingLayer(SerializedProperty elem, string name, int uid)
    {
        elem.FindPropertyRelative("name").stringValue = name;
        elem.FindPropertyRelative("uniqueID").intValue = uid;
    }

    private static void ConfigureNativePlugins()
    {
        string[] sos = new string[]
        {
            "Assets/Plugins/Android/libs/arm64-v8a/libtolua.so",
            "Assets/Plugins/Android/libs/arm64-v8a/libLive2DCubismCore.so"
        };
        foreach (string p in sos)
        {
            PluginImporter pi = AssetImporter.GetAtPath(p) as PluginImporter;
            if (pi != null)
            {
                pi.SetCompatibleWithAnyPlatform(false);
                pi.SetCompatibleWithEditor(false);
                pi.SetCompatibleWithPlatform(BuildTarget.Android, true);
                pi.SetPlatformData(BuildTarget.Android, "CPU", "ARM64");
                pi.SaveAndReimport();
                Debug.Log("[BuildArm64] Configured ARM64 native plugin: " + p);
            }
        }
    }

    private static void ConfigureBuiltinResources()
    {
        // Horizon & Verticle must be imported as Sprites (Resources.Load<Sprite>("Horizon"/"Verticle"))
        string[] spritePaths = new string[]
        {
            "Assets/Resources/Horizon.png",
            "Assets/Resources/Verticle.png"
        };
        foreach (string p in spritePaths)
        {
            TextureImporter ti = AssetImporter.GetAtPath(p) as TextureImporter;
            if (ti != null)
            {
                ti.textureType = TextureImporterType.Sprite;
                ti.spriteImportMode = SpriteImportMode.Single;
                ti.spritePixelsPerUnit = 100f;
                ti.mipmapEnabled = false;
                ti.npotScale = TextureImporterNPOTScale.None;
                ti.SaveAndReimport();
                Debug.Log("[BuildArm64] Configured Sprite: " + p);
            }
        }

        // Splash textures: no mipmap, no NPOT resize so SetNativeSize() renders crisp
        string[] texPaths = new string[]
        {
            "Assets/Resources/logoFirst.png",
            "Assets/Resources/logoMingChao.png",
            "Assets/Resources/bottom.png",
            "Assets/Resources/ArkOrder.png"
        };
        foreach (string p in texPaths)
        {
            TextureImporter ti = AssetImporter.GetAtPath(p) as TextureImporter;
            if (ti != null)
            {
                ti.textureType = TextureImporterType.Default;
                ti.mipmapEnabled = false;
                ti.npotScale = TextureImporterNPOTScale.None;
                ti.SaveAndReimport();
            }
        }

        // Builtin AnimatorController & TrailRenderer prefabs (matching fzzl ResourceManager)
        string acPath = "Assets/Resources/AnimatorController.controller";
        AnimatorController ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>(acPath);
        if (ctrl == null)
        {
            ctrl = AnimatorController.CreateAnimatorControllerAtPath(acPath);
        }

        string acPrefabPath = "Assets/Resources/AnimatorController.prefab";
        if (AssetDatabase.LoadAssetAtPath<GameObject>(acPrefabPath) == null)
        {
            GameObject go = new GameObject("AnimatorController");
            go.transform.localPosition = new Vector3(0.5088f, 0.26053333f, 0f);
            Animator anim = go.AddComponent<Animator>();
            anim.runtimeAnimatorController = ctrl;
            PrefabUtility.CreatePrefab(acPrefabPath, go);
            UnityEngine.Object.DestroyImmediate(go);
        }

        string trPrefabPath = "Assets/Resources/TrailRenderer.prefab";
        if (AssetDatabase.LoadAssetAtPath<GameObject>(trPrefabPath) == null)
        {
            GameObject go = new GameObject("TrailRenderer");
            go.transform.localPosition = new Vector3(-0.0281456f, 0.01873273f, -8f);
            go.AddComponent<TrailRenderer>();
            PrefabUtility.CreatePrefab(trPrefabPath, go);
            UnityEngine.Object.DestroyImmediate(go);
        }

        AssetDatabase.SaveAssets();
        Debug.Log("[BuildArm64] Builtin Resources configured.");
    }

    private static void ConfigureAlwaysIncludedShaders()
    {
        // Exact 30 AlwaysIncludedShaders extracted from original fzzl_lua_signed.apk globalgamemanagers
        // plus Live2D 2.1 merged shaders & extra built-in Particle/Unlit variants to prevent pink materials.
        string[] shaderNames = new string[]
        {
            "Legacy Shaders/Diffuse",
            "Hidden/CubeBlur",
            "Hidden/CubeCopy",
            "Hidden/CubeBlend",
            "Sprites/Default",
            "Sprites/Mask",
            "UI/Default",
            "UI/Default Font",
            "Mobile/Unlit (Supports Lightmap)",
            "Particles/Additive",
            "Particles/Alpha Blended",
            "Particles/Additive (Soft)",
            "Particles/Multiply",
            "Particles/Alpha Blended Premultiply",
            "Mobile/Particles/Additive",
            "Mobile/Particles/Alpha Blended",
            "Mobile/Particles/Multiply",
            "Unlit/Transparent",
            "Unlit/Texture",
            "Live2D/SetupMask",
            "Live2D/Live2D",
            "Live2D/Live2D Masked",
            "Live2D/Live2D PremultipliedAlpha",
            "Live2D/Live2D Masked PremultipliedAlpha",
            "Hidden/VideoDecode",
            "Hidden/VideoDecodeAndroid",
            "Hidden/Compositing",
            "Hidden/Internal-StencilWrite",
            "Hidden/Internal-CombineDepthNormals",
            "Hidden/BlitCopy",
            "Hidden/BlitCopyDepth",
            "Hidden/BlitToDepth",
            "Hidden/BlitToDepth_MSAA",
            "Hidden/BlitCopyWithDepth",
            "Hidden/Internal-GUITextureClip",
            "Hidden/Internal-GUITextureClipText",
            "Hidden/Internal-GUITexture",
            "Hidden/Internal-GUITextureBlit",
            "Hidden/Internal-GUIRoundedRect",
            "Hidden/ConvertTexture"
        };
        UnityEngine.Object[] gfxAssets = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/GraphicsSettings.asset");
        if (gfxAssets == null || gfxAssets.Length == 0) return;
        SerializedObject so = new SerializedObject(gfxAssets[0]);
        SerializedProperty list = so.FindProperty("m_AlwaysIncludedShaders");
        foreach (string sname in shaderNames)
        {
            Shader sh = Shader.Find(sname);
            if (sh == null)
            {
                Debug.LogWarning("[BuildArm64] Shader not found: " + sname);
                continue;
            }
            bool exists = false;
            for (int i = 0; i < list.arraySize; i++)
            {
                if (list.GetArrayElementAtIndex(i).objectReferenceValue == sh) { exists = true; break; }
            }
            if (!exists)
            {
                int idx = list.arraySize;
                list.InsertArrayElementAtIndex(idx);
                list.GetArrayElementAtIndex(idx).objectReferenceValue = sh;
            }
        }
        so.ApplyModifiedPropertiesWithoutUndo();
        AssetDatabase.SaveAssets();
        Debug.Log("[BuildArm64] AlwaysIncludedShaders updated.");
    }

    private static void ConfigurePlayerSettings(string productName, string bundleVer, int versionCode)
    {
        EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
        EditorUserBuildSettings.androidBuildSystem = AndroidBuildSystem.Internal;

        PlayerSettings.companyName = "mingchao";
        PlayerSettings.productName = productName;
        PlayerSettings.SetApplicationIdentifier(BuildTargetGroup.Android, "com.bilibili.fzzl.guopan");
        PlayerSettings.bundleVersion = bundleVer;
        PlayerSettings.Android.bundleVersionCode = versionCode;
        PlayerSettings.defaultInterfaceOrientation = UIOrientation.AutoRotation;
        PlayerSettings.allowedAutorotateToPortrait = false;
        PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
        PlayerSettings.allowedAutorotateToLandscapeLeft = true;
        PlayerSettings.allowedAutorotateToLandscapeRight = true;
        PlayerSettings.runInBackground = true;

        // App Icon from Assets/Editor/AppIcon512.png
        Texture2D iconTex = AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Editor/AppIcon512.png");
        if (iconTex != null)
        {
            int[] sizes = PlayerSettings.GetIconSizesForTargetGroup(BuildTargetGroup.Android);
            Texture2D[] icons = new Texture2D[sizes.Length];
            for (int i = 0; i < sizes.Length; i++) icons[i] = iconTex;
            PlayerSettings.SetIconsForTargetGroup(BuildTargetGroup.Android, icons);
            Debug.Log("[BuildArm64] App icon set (" + sizes.Length + " buckets).");
        }

        // Lock OpenGL ES3 -> ES2 (NO Vulkan) for original AB shader compatibility
        PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
        PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new GraphicsDeviceType[]
        {
            GraphicsDeviceType.OpenGLES3,
            GraphicsDeviceType.OpenGLES2
        });

        PlayerSettings.SetScriptingBackend(BuildTargetGroup.Android, ScriptingImplementation.IL2CPP);
        PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
        PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel21;
        PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevel26;
        PlayerSettings.stripEngineCode = false;
        PlayerSettings.strippingLevel = StrippingLevel.Disabled;

        string ksPass = Environment.GetEnvironmentVariable("FZZL_KS_PASS");
        if (!string.IsNullOrEmpty(ksPass))
        {
            string repoRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "../../.."));
            PlayerSettings.Android.keystoreName = Environment.GetEnvironmentVariable("FZZL_KEYSTORE") ?? Path.Combine(Path.Combine(repoRoot, "tools"), "fzzl.keystore");
            PlayerSettings.Android.keystorePass = ksPass;
            PlayerSettings.Android.keyaliasName = "fzzl";
            PlayerSettings.Android.keyaliasPass = ksPass;
            Debug.Log("[BuildArm64] Using fzzl.keystore with env FZZL_KS_PASS.");
        }
        else
        {
            Debug.LogWarning("[BuildArm64] FZZL_KS_PASS not set; using default debug keystore.");
        }
    }

    /// <summary>
    /// 1:1 还原原版 fzzl.apk level0 (Assets/Scenes/Main.unity) 的 6 个 GameObject 及其全部组件参数。
    /// </summary>
    private static string CreateMainScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        // RenderSettings matching level0
        RenderSettings.fog = false;
        RenderSettings.ambientMode = AmbientMode.Flat;
        RenderSettings.ambientSkyColor = new Color(0.2f, 0.2f, 0.2f, 1f);
        RenderSettings.skybox = null;

        // 1. EventSystem
        GameObject esGo = new GameObject("EventSystem");
        esGo.layer = 0;
        EventSystem es = esGo.AddComponent<EventSystem>();
        es.sendNavigationEvents = true;
        es.pixelDragThreshold = 5;
        StandaloneInputModule sim = esGo.AddComponent<StandaloneInputModule>();
        sim.horizontalAxis = "Horizontal";
        sim.verticalAxis = "Vertical";
        sim.submitButton = "Submit";
        sim.cancelButton = "Cancel";
        sim.inputActionsPerSecond = 10f;
        sim.repeatDelay = 0.5f;
        sim.forceModuleActive = false;

        // 2. SceneTopCamera (Layer 31 Scene, cullingMask = 1<<30 SceneTop)
        GameObject stcGo = new GameObject("SceneTopCamera");
        stcGo.layer = 31;
        stcGo.transform.localPosition = new Vector3(0f, 1.11514544f, -1.891f);
        Camera stc = stcGo.AddComponent<Camera>();
        stc.clearFlags = CameraClearFlags.Depth;
        stc.backgroundColor = new Color(0f, 0f, 0f, 0f);
        stc.nearClipPlane = 0.3f;
        stc.farClipPlane = 1000f;
        stc.fieldOfView = 30f;
        stc.orthographic = true;
        stc.orthographicSize = 5.5f;
        stc.depth = 1f;
        stc.cullingMask = 1073741824; // 1 << 30 (SceneTop)
        stc.allowHDR = false;
        stc.allowMSAA = true;
        stcGo.AddComponent<FlareLayer>();
        stcGo.AddComponent<GUILayer>();

        // 3. Shell (Launcher -> Bootstrap.Init() + Main)
        GameObject shellGo = new GameObject("Shell");
        shellGo.layer = 0;
        shellGo.transform.localPosition = new Vector3(0f, 135.4f, 0f);
        shellGo.transform.localRotation = new Quaternion(0.7071069f, 0f, 0f, 0.7071068f);
        shellGo.AddComponent<Launcher>();

        // 4. UIRoot + child Camera (Layer 5 UI)
        GameObject uiRootGo = new GameObject("UIRoot");
        uiRootGo.layer = 5;
        RectTransform uiRt = uiRootGo.AddComponent<RectTransform>();
        uiRt.anchorMin = Vector2.zero;
        uiRt.anchorMax = Vector2.zero;
        uiRt.anchoredPosition = Vector2.zero;
        uiRt.pivot = new Vector2(0.5f, 0.5f);

        GameObject uiCamGo = new GameObject("Camera");
        uiCamGo.layer = 5;
        uiCamGo.transform.SetParent(uiRootGo.transform, false);
        uiCamGo.transform.localPosition = Vector3.zero;
        Camera uiCam = uiCamGo.AddComponent<Camera>();
        uiCam.clearFlags = CameraClearFlags.Depth;
        uiCam.backgroundColor = new Color(0.19215687f, 0.3019608f, 0.4745098f, 0.019607844f);
        uiCam.nearClipPlane = -100f;
        uiCam.farClipPlane = 10f;
        uiCam.fieldOfView = 60f;
        uiCam.orthographic = true;
        uiCam.orthographicSize = 1f;
        uiCam.depth = 2f;
        uiCam.cullingMask = 32; // 1 << 5 (UI)
        uiCam.allowHDR = false;
        uiCam.allowMSAA = true;

        Canvas canvas = uiRootGo.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceCamera;
        canvas.worldCamera = uiCam;
        canvas.planeDistance = 100f;
        canvas.pixelPerfect = false;
        canvas.additionalShaderChannels = (AdditionalCanvasShaderChannels)25;

        CanvasScaler scaler = uiRootGo.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referencePixelsPerUnit = 100f;
        scaler.scaleFactor = 1f;
        scaler.referenceResolution = new Vector2(1334f, 750f);
        scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        scaler.matchWidthOrHeight = 0f;

        GraphicRaycaster raycaster = uiRootGo.AddComponent<GraphicRaycaster>();
        raycaster.ignoreReversedGraphics = false;
        raycaster.blockingObjects = GraphicRaycaster.BlockingObjects.None;

        // 5. SceneCamera (Tag="MainCamera", Layer 31 Scene, cullingMask = 2147485697)
        GameObject scGo = new GameObject("SceneCamera");
        scGo.layer = 31;
        scGo.tag = "MainCamera";
        scGo.transform.localPosition = new Vector3(0f, 1.11514544f, -1.89100015f);
        Camera sc = scGo.AddComponent<Camera>();
        sc.clearFlags = CameraClearFlags.Skybox;
        sc.backgroundColor = new Color(0f, 0f, 0f, 0f);
        sc.nearClipPlane = 0.3f;
        sc.farClipPlane = 1000f;
        sc.fieldOfView = 30f;
        sc.orthographic = true;
        sc.orthographicSize = 3.20601845f;
        sc.depth = 0f;
        sc.cullingMask = unchecked((int)2147485697u); // (1<<31)|(1<<11)|(1<<0)
        sc.allowHDR = false;
        sc.allowMSAA = true;
        scGo.AddComponent<FlareLayer>();
        scGo.AddComponent<GUILayer>();
        Physics2DRaycaster p2d = scGo.AddComponent<Physics2DRaycaster>();
        p2d.eventMask = unchecked((int)0xdfffffffu);
        p2d.maxRayIntersections = 0;

        string dir = "Assets/Scenes";
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        string scenePath = dir + "/Main.unity";
        EditorSceneManager.SaveScene(scene, scenePath);
        Debug.Log("[BuildArm64] Saved Main scene: " + scenePath);
        return scenePath;
    }

}
