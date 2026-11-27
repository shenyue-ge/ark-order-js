# -*- coding: utf-8 -*-
"""
setup_builtin_resources.py —— 为 unity_project/Assets/Resources/ 铺设全部 16 项内置资源：
  1. 6 张图片：
     - logoFirst.png  (使用 apkbuild/out/logoFirst.asset.patched 替换版 593x150)
     - logoMingChao.png
     - bottom.png
     - ArkOrder.png
     - Horizon.png    (Sprite 导入，供 Resources.Load<Sprite>("Horizon"))
     - Verticle.png   (Sprite 导入，供 Resources.Load<Sprite>("Verticle"))
  2. 5 个 Live2D 2.1 内置 Shader（按 fzzl.apk 反编 GLSL 1:1 还原）：
     - Resources/Shader/Live2D/Live2D-SetupMask.shader
     - Resources/Shader/Live2D/Merged/Live2D.shader
     - Resources/Shader/Live2D/Merged/Live2D-Masked.shader
     - Resources/Shader/Live2D/Merged/Live2D-PremultipliedAlpha.shader
     - Resources/Shader/Live2D/Merged/Live2D-Masked-PremultipliedAlpha.shader
  3. 应用图标 512px PNG（来自 方舟指令3.webp → Assets/Editor/AppIcon512.png，供 PlayerSettings.SetIconsForTargetGroup 使用）
"""
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD64 = os.path.dirname(HERE)
ROOT = os.path.dirname(BUILD64)
PROJ = os.path.join(BUILD64, 'unity_project')
RES = os.path.join(PROJ, 'Assets', 'Resources')
STAGING_RES = os.path.join(BUILD64, 'staging', 'builtin_resources')

SHADERS = {
    'Shader/Live2D/Live2D-SetupMask.shader': r'''Shader "Live2D/SetupMask" {
    Properties {
        _MainTex ("Base (RGB)", 2D) = "white" {}
    }
    SubShader {
        LOD 100
        Tags { "Queue"="Transparent" "IgnoreProjector"="True" "RenderType"="Transparent" }
        Pass {
            ZWrite Off
            Cull Off
            Blend Zero OneMinusSrcColor, Zero OneMinusSrcAlpha

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4x4 _MaskMatrix;
            float4 _ChannelFlag;
            float4 _Bounds;

            struct appdata {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            struct v2f {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float4 clipPos : TEXCOORD1;
                float4 color : COLOR;
            };

            v2f vert(appdata v) {
                v2f o;
                o.pos = mul(_MaskMatrix, v.vertex);
                o.clipPos = o.pos;
                o.uv = v.uv;
                o.color = v.color;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target {
                float2 clip = i.clipPos.xy / i.clipPos.w;
                float isInside = step(_Bounds.x, clip.x) * step(_Bounds.y, clip.y)
                               * step(clip.x, _Bounds.z) * step(clip.y, _Bounds.w);
                return _ChannelFlag * tex2D(_MainTex, i.uv).a * isInside;
            }
            ENDCG
        }
    }
}
''',

    'Shader/Live2D/Merged/Live2D.shader': r'''Shader "Live2D/Live2D" {
    Properties {
        _Cull ("Culling", Float) = 0
        _SrcColor ("SrcColor", Float) = 0
        _DstColor ("DstColor", Float) = 0
        _SrcAlpha ("SrcAlpha", Float) = 0
        _DstAlpha ("DstAlpha", Float) = 0
    }
    SubShader {
        LOD 100
        Tags { "Queue"="Transparent" "IgnoreProjector"="True" "RenderType"="Transparent" }
        Pass {
            ZWrite Off
            Cull [_Cull]
            Blend [_SrcColor] [_DstColor], [_SrcAlpha] [_DstAlpha]

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;

            struct appdata {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            struct v2f {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            v2f vert(appdata v) {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.color = v.color;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target {
                fixed4 col = tex2D(_MainTex, i.uv) * i.color;
                col.rgb *= col.a;
                return col;
            }
            ENDCG
        }
    }
}
''',

    'Shader/Live2D/Merged/Live2D-PremultipliedAlpha.shader': r'''Shader "Live2D/Live2D PremultipliedAlpha" {
    Properties {
        _Cull ("Culling", Float) = 0
        _SrcColor ("SrcColor", Float) = 0
        _DstColor ("DstColor", Float) = 0
        _SrcAlpha ("SrcAlpha", Float) = 0
        _DstAlpha ("DstAlpha", Float) = 0
    }
    SubShader {
        LOD 100
        Tags { "Queue"="Transparent" "IgnoreProjector"="True" "RenderType"="Transparent" }
        Pass {
            ZWrite Off
            Cull [_Cull]
            Blend [_SrcColor] [_DstColor], [_SrcAlpha] [_DstAlpha]

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;

            struct appdata {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            struct v2f {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            v2f vert(appdata v) {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.color = v.color;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target {
                return tex2D(_MainTex, i.uv) * i.color;
            }
            ENDCG
        }
    }
}
''',

    'Shader/Live2D/Merged/Live2D-Masked.shader': r'''Shader "Live2D/Live2D Masked" {
    Properties {
        _Cull ("Culling", Float) = 0
        _SrcColor ("SrcColor", Float) = 0
        _DstColor ("DstColor", Float) = 0
        _SrcAlpha ("SrcAlpha", Float) = 0
        _DstAlpha ("DstAlpha", Float) = 0
    }
    SubShader {
        LOD 100
        Tags { "Queue"="Transparent" "IgnoreProjector"="True" "RenderType"="Transparent" }
        Pass {
            ZWrite Off
            Cull [_Cull]
            Blend [_SrcColor] [_DstColor], [_SrcAlpha] [_DstAlpha]

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            sampler2D _ClipTex;
            float4x4 _ClipMatrix;
            float4 _ChannelFlag;

            struct appdata {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            struct v2f {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float4 clipPos : TEXCOORD1;
                float4 color : COLOR;
            };

            v2f vert(appdata v) {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.clipPos = mul(_ClipMatrix, v.vertex);
                o.color = v.color;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target {
                fixed4 clipMask = (1.0 - tex2D(_ClipTex, i.clipPos.xy / i.clipPos.w)) * _ChannelFlag;
                fixed maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
                fixed4 col = tex2D(_MainTex, i.uv) * i.color;
                col.rgb *= col.a;
                return col * maskVal;
            }
            ENDCG
        }
    }
}
''',

    'Shader/Live2D/Merged/Live2D-Masked-PremultipliedAlpha.shader': r'''Shader "Live2D/Live2D Masked PremultipliedAlpha" {
    Properties {
        _Cull ("Culling", Float) = 0
        _SrcColor ("SrcColor", Float) = 0
        _DstColor ("DstColor", Float) = 0
        _SrcAlpha ("SrcAlpha", Float) = 0
        _DstAlpha ("DstAlpha", Float) = 0
    }
    SubShader {
        LOD 100
        Tags { "Queue"="Transparent" "IgnoreProjector"="True" "RenderType"="Transparent" }
        Pass {
            ZWrite Off
            Cull [_Cull]
            Blend [_SrcColor] [_DstColor], [_SrcAlpha] [_DstAlpha]

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            sampler2D _ClipTex;
            float4x4 _ClipMatrix;
            float4 _ChannelFlag;

            struct appdata {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR;
            };

            struct v2f {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float4 clipPos : TEXCOORD1;
                float4 color : COLOR;
            };

            v2f vert(appdata v) {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.clipPos = mul(_ClipMatrix, v.vertex);
                o.color = v.color;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target {
                fixed4 clipMask = (1.0 - tex2D(_ClipTex, i.clipPos.xy / i.clipPos.w)) * _ChannelFlag;
                fixed maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
                fixed4 col = tex2D(_MainTex, i.uv) * i.color;
                return col * maskVal;
            }
            ENDCG
        }
    }
}
''',
}


def main():
    os.makedirs(RES, exist_ok=True)
    # 1. 6 张图片（logoFirst 使用替换版 logoFirst_patched.png）
    tex_map = {
        'logoFirst.png': 'logoFirst_patched.png',
        'logoMingChao.png': '1ba86f683a2e1468bbb04ff2b26717a5__logoMingChao_1.png',
        'bottom.png': 'c4c0f9f1aae9d9b4891b8a478c508c24__bottom_1.png',
        'ArkOrder.png': 'ed7f9e38c9aab44a1960495ea229e06b__ArkOrder_1.png',
        'Horizon.png': 'cecb6fc996eba4a869179a033bc2ea5f__Horizon_1.png',
        'Verticle.png': '9ec113c03ce1c448fa4780d58edaff0a__Verticle_1.png',
    }
    for dst_name, src_name in tex_map.items():
        src = os.path.join(STAGING_RES, src_name)
        assert os.path.isfile(src), f'missing {src}'
        dst = os.path.join(RES, dst_name)
        shutil.copy2(src, dst)
        print(f'  [TEX] {dst_name} <- {src_name} ({os.path.getsize(dst):,} B)')

    # 2. 5 个 Live2D 2.1 Shaders
    for rel, content in SHADERS.items():
        dst = os.path.join(RES, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
        print(f'  [SHD] {rel}')

    # 3. App icon 512px PNG for Unity PlayerSettings
    from PIL import Image
    icon_src = os.environ.get('FZZL_ICON_SRC', os.path.join(ROOT, 'icon.webp'))
    if os.path.isfile(icon_src):
        icon_dst = os.path.join(PROJ, 'Assets', 'Editor', 'AppIcon512.png')
        Image.open(icon_src).convert('RGBA').resize((512, 512), Image.LANCZOS).save(icon_dst, 'PNG')
        print(f'  [ICO] {icon_dst} (512x512)')

    print('== setup_builtin_resources DONE')


if __name__ == '__main__':
    main()
