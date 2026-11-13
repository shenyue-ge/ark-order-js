// 战斗技能效果规则表（由 CfgSkillDetail.lua 与 FightFeature.lua 提炼生成）
// 覆盖属性升降（Stat Stages: 101~115）、异常状态（Buffs: 50001~50008）及衍生特性包

const PROP_CODES = {
  PHY_ATK: 101,
  MAG_ATK: 102,
  PHY_DEF: 103,
  MAG_DEF: 104,
  SPEED: 105,
  CRIT_HIT: 111,
  HIT_RATE: 113,
  DODGE_RATE: 115,
};

// 属性码对应客户端属性字段名
const PROP_ATTR_NAMES = {
  101: 'phy_atk_lv',
  102: 'mag_atk_lv',
  103: 'phy_def_lv',
  104: 'mag_def_lv',
  105: 'speed_lv',
  111: 'crit_hit_lv',
  113: 'hit_rate_lv',
  115: 'dodge_rate_lv',
};

// 属性等级变化触发的特性 ID（FightFeature.lua 20001~20008，驱动客户端弹出浮字：#tar的\n魔攻上升了#value级）
const PROP_FEATURE_IDS = {
  101: 20001, // 物攻
  102: 20002, // 魔攻
  103: 20003, // 物防
  104: 20004, // 魔防
  105: 20005, // 速度
  113: 20006, // 命中
  115: 20007, // 闪避
  111: 20008, // 会心/暴击
};

// 异常状态码（CfgBuff.lua）
const BUFF_IDS = {
  PARALYSIS: 50001, // 麻痹
  BURN: 50002,      // 烧伤
  FREEZE: 50003,    // 冻结
  SLEEP: 50004,     // 睡眠
  POISON: 50005,    // 中毒
  TAUNT: 50006,     // 激怒
  CONFUSION: 50007, // 混乱
  RAGE: 50008,      // 暴怒
  FOCUS: 10690,     // 心神凝聚
};

// 异常状态对应的官方特性提示 ID（FightFeature.lua 90000 系列）
const BUFF_FEATURE_IDS = {
  50001: { apply: 90001, trigger: 90002, remove: 90003 }, // 麻痹
  50002: { apply: 90101, trigger: 90102, remove: 90103 }, // 烧伤
  50003: { apply: 90201, trigger: 90202, remove: 90203 }, // 冻结
  50004: { apply: 90701, trigger: 90701, remove: 90702 }, // 睡眠
  50005: { apply: 90801, trigger: 90801, remove: 90803 }, // 中毒
  50006: { apply: 90901, trigger: 90901, remove: 90902 }, // 激怒
  50007: { apply: 90401, trigger: 90402, remove: 90403 }, // 混乱
  10690: { apply: 10691, trigger: 10691, remove: 10691 }, // 心神凝聚 ("心神凝聚生效", tips: "#src集中了精神！")
  // 时空禁锢（10274 空间箭）：客户端 FightFeature **没有**官方展示条目（全表 0 命中），
  // 落默认 90001 会弹「麻痹生效」错文案 ⇒ 用 showName=0 无 tips 的 60120 静默结算；
  // 图标本身由 300019/300020 的 encodeBuffVal(12395) 驱动（CfgBuff 有 icon），与展示 id 无关。
  12395: { apply: 60120, trigger: 60120, remove: 60120 },
};

// 属性变更值编码（客户端 FightUtil.getAdditionAttrCode / getAdditionAttrValue 标准：code * 1000 + (delta + 100)）
function encodeAttrVal(propCode, delta) {
  return Number(propCode) * 1000 + (Number(delta) + 100);
}

// Buff 编码（客户端 FeatureLoop.lua 标准：level * 1000000 + buffId）
function encodeBuffVal(buffId, level) {
  return (Number(level) || 1) * 1000000 + Number(buffId);
}

// 技能效果规则库
const SKILL_EFFECT_RULES = {
  "10014": {
    "id": 10014,
    "name": "归还的极光",
    "effType": 3007,
    "type": 3,
    "resetStats": "all"
  },
  "10017": {
    "id": 10017,
    "name": "激流斩",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 50
      }
    ]
  },
  "10019": {
    "id": 10019,
    "name": "寒流",
    "effType": 1052,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 105,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10020": {
    "id": 10020,
    "name": "泡沫之雨",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 105,
        "delta": -1,
        "chance": 10
      }
    ]
  },
  "10021": {
    "id": 10021,
    "name": "腐蚀毒素",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 30,
        "duration": 3
      }
    ]
  },
  "10024": {
    "id": 10024,
    "name": "强酸喷射",
    "effType": 1052,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 10
      }
    ]
  },
  "10027": {
    "id": 10027,
    "name": "暴风雪",
    "effType": 1056,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50003,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "10028": {
    "id": 10028,
    "name": "升天海流",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 50
      }
    ]
  },
  "10031": {
    "id": 10031,
    "name": "熔岩撕咬",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10032": {
    "id": 10032,
    "name": "炎之剑",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 10
      }
    ],
    "buffs": [
      {
        "target": "target",
        "buffId": 50002,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "10035": {
    "id": 10035,
    "name": "爆炎冲击",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 50
      }
    ]
  },
  "10036": {
    "id": 10036,
    "name": "燃魂一击",
    "effType": 1007,
    "type": 1,
    // CfgSkillDetail 10036 desc：「竭尽全力释放的一击。可使物攻上升1级」——
    // 没写"目标"，本作惯例即**使用者自己**。原来写成 target 会被 applySkillEffects
    // 判成 affected=targets（攻击技=敌方），真机表现就是"打敌人反而给敌人加物攻"。
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10038": {
    "id": 10038,
    "name": "炼狱黑炎",
    "effType": 1056,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 50
      }
    ]
  },
  "10040": {
    "id": 10040,
    "name": "极热射线",
    "effType": 1052,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50002,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "10045": {
    "id": 10045,
    "name": "俯冲猎杀",
    "effType": 1007,
    "type": 1,
    "buffs": [
      {
        "target": "target",
        "buffId": 50001,
        "chance": 30,
        "duration": 3
      }
    ]
  },
  "10048": {
    "id": 10048,
    "name": "风行之舞踏",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 105,
        "delta": 1,
        "chance": 50
      }
    ]
  },
  "10054": {
    "id": 10054,
    "name": "飓风狂乱",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50007,
        "chance": 30,
        "duration": 3
      }
    ]
  },
  "10062": {
    "id": 10062,
    "name": "泥浆射击",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 113,
        "delta": -1,
        "chance": 20
      }
    ]
  },
  "10063": {
    "id": 10063,
    "name": "大地波动",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 20
      }
    ]
  },
  "10065": {
    "id": 10065,
    "name": "泥炼成-锤",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50001,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10072": {
    "id": 10072,
    "name": "炫目之光",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 113,
        "delta": -1,
        "chance": 10
      }
    ]
  },
  "10074": {
    "id": 10074,
    "name": "救赎的咏唱",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 10
      }
    ]
  },
  "10075": {
    "id": 10075,
    "name": "终焉咏叹诗",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": -2,
        "chance": 100
      }
    ]
  },
  "10080": {
    "id": 10080,
    "name": "夜魔之宴",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 20
      }
    ]
  },
  "10083": {
    "id": 10083,
    "name": "罪人的怨灵",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 10
      }
    ]
  },
  "10084": {
    "id": 10084,
    "name": "迷惑之声",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50007,
        "chance": 30,
        "duration": 3
      }
    ]
  },
  "10085": {
    "id": 10085,
    "name": "恶魔的秘术",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffRandom": [
          50001,
          50002,
          50003
        ],
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "10086": {
    "id": 10086,
    "name": "堕天破灭曲",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": -2,
        "chance": 100
      }
    ]
  },
  "10087": {
    "id": 10087,
    "name": "激昂战意",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 2,
        "chance": 100
      }
    ]
  },
  "10088": {
    "id": 10088,
    "name": "岩石铠甲",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 103,
        "delta": 2,
        "chance": 100
      }
    ]
  },
  "10089": {
    "id": 10089,
    "name": "魔力赐福",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": 2,
        "chance": 100
      }
    ]
  },
  "10090": {
    "id": 10090,
    "name": "噬魔之力",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 104,
        "delta": 2,
        "chance": 100
      }
    ]
  },
  "10091": {
    "id": 10091,
    "name": "疾风的祝福",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 105,
        "delta": 2,
        "chance": 100
      }
    ]
  },
  "10093": {
    "id": 10093,
    "name": "明镜止水",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": 1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 104,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10094": {
    "id": 10094,
    "name": "肉体强化",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 103,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10095": {
    "id": 10095,
    "name": "活力驱动",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 105,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10096": {
    "id": 10096,
    "name": "毒雾",
    "effType": 1058,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10097": {
    "id": 10097,
    "name": "毒素",
    "effType": 1007,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10098": {
    "id": 10098,
    "name": "催眠曲",
    "effType": 1007,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10099": {
    "id": 10099,
    "name": "风之锁链",
    "effType": 1007,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50001,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10100": {
    "id": 10100,
    "name": "妖火",
    "effType": 1007,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50002,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10101": {
    "id": 10101,
    "name": "妖言",
    "effType": 1007,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50007,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10105": {
    "id": 10105,
    "name": "心神凝聚",
    "effType": 2001,
    "type": 3,
    "buffs": [
      {
        "target": "self",
        "buffId": 10690,
        "chance": 100,
        "duration": 5
      }
    ]
  },
  "10106": {
    "id": 10106,
    "name": "威压",
    "effType": 1056,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10107": {
    "id": 10107,
    "name": "震慑",
    "effType": 1056,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10108": {
    "id": 10108,
    "name": "束缚",
    "effType": 1056,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 105,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10109": {
    "id": 10109,
    "name": "痊愈之歌",
    "effType": 2002,
    "type": 3,
    "clearDebuffs": true
  },
  "10111": {
    "id": 10111,
    "name": "战吼",
    "effType": 2002,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 101,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10112": {
    "id": 10112,
    "name": "硬质化",
    "effType": 2002,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10113": {
    "id": 10113,
    "name": "冥思",
    "effType": 2002,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 102,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10114": {
    "id": 10114,
    "name": "对魔力强化",
    "effType": 2002,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10115": {
    "id": 10115,
    "name": "恶魔的契约",
    "effType": 2001,
    "type": 3,
    "selfHpCostPct": 50,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 6,
        "chance": 100
      }
    ]
  },
  "10120": {
    "id": 10120,
    "name": "迷乱之风",
    "effType": 1007,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10122": {
    "id": 10122,
    "name": "突击架势",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 2,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 102,
        "delta": 2,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 105,
        "delta": 2,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 103,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 104,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10124": {
    "id": 10124,
    "name": "永结冰棺",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50003,
        "chance": 30,
        "duration": 3
      }
    ]
  },
  "10125": {
    "id": 10125,
    "name": "断罪炎王剑",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": -2,
        "chance": 100
      }
    ]
  },
  "10126": {
    "id": 10126,
    "name": "风尘乱舞",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": -2,
        "chance": 100
      }
    ]
  },
  "10132": {
    "id": 10132,
    "name": "痊愈之颂咏",
    "effType": 2011,
    "type": 3,
    "clearDebuffs": true
  },
  "10133": {
    "id": 10133,
    "name": "武装解除",
    "effType": 1058,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10135": {
    "id": 10135,
    "name": "夜鸦的诅咒",
    "effType": 1056,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "10136": {
    "id": 10136,
    "name": "死神之镰",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffRandom": [
          50001,
          50002,
          50003,
          50004,
          50005
        ],
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "10137": {
    "id": 10137,
    "name": "黑洞",
    "effType": 1058,
    "type": 2,
    "resetStats": "target"
  },
  "10138": {
    "id": 10138,
    "name": "灼炎风暴",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50002,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "10141": {
    "id": 10141,
    "name": "空气炮",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 15
      }
    ]
  },
  "10142": {
    "id": 10142,
    "name": "贤者辉光",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": 1,
        "chance": 15
      }
    ]
  },
  "10145": {
    "id": 10145,
    "name": "暗之跃动",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": 1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 105,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10146": {
    "id": 10146,
    "name": "天召雷",
    "effType": 1052,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50001,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "10147": {
    "id": 10147,
    "name": "雷鸣斩",
    "effType": 1108,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 50
      }
    ]
  },
  "10148": {
    "id": 10148,
    "name": "破岩剑",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10152": {
    "id": 10152,
    "name": "圣洁的烈焰",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50001,
        "chance": 100,
        "duration": 3
      },
      {
        "target": "target",
        "buffId": 50002,
        "chance": 100,
        "duration": 3
      },
      {
        "target": "target",
        "buffId": 50004,
        "chance": 100,
        "duration": 3
      },
      {
        "target": "target",
        "buffId": 50005,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10155": {
    "id": 10155,
    "name": "弹幕：高能",
    "effType": 1052,
    "type": 1,
    "buffs": [
      {
        "target": "target",
        "buffId": 50002,
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "10157": {
    "id": 10157,
    "name": "弹幕：电波",
    "effType": 1007,
    "type": 1,
    "buffs": [
      {
        "target": "target",
        "buffId": 50001,
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "10161": {
    "id": 10161,
    "name": "弹幕：空耳",
    "effType": 1056,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "10163": {
    "id": 10163,
    "name": "弹幕：吐槽",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "10175": {
    "id": 10175,
    "name": "地狱之门",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10176": {
    "id": 10176,
    "name": "灭绝的炎剑",
    "effType": 1058,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 103,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 104,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 105,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10177": {
    "id": 10177,
    "name": "狂热毒液",
    "effType": 2002,
    "type": 3,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10178": {
    "id": 10178,
    "name": "新月之光",
    "effType": 2002,
    "type": 3,
    "clearDebuffs": true
  },
  "10183": {
    "id": 10183,
    "name": "北冥之海流",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 102,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10185": {
    "id": 10185,
    "name": "全知之风",
    "effType": 1056,
    "type": 2,
    "statChanges": [
      {
        "target": "self",
        "prop": 103,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 104,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10189": {
    "id": 10189,
    "name": "元气之音",
    "effType": 1052,
    "type": 1,
    // desc：「根据击中的目标数使己方对应数量的随机誓灵速度上升1级，解除己方所有睡眠状态」
    // 原配置把「速度+1」和「睡眠 3 回合」都挂在 target 上 —— 攻击技的 targets 是敌方，
    // 实际效果成了"给敌人加速并让敌人睡眠"，与描述完全相反。此处先纠正方向：
    //   · 速度 +1 改为 self（最小正确化）
    //   · 删除睡眠 buff（描述里没有"使目标睡眠"）
    // ⚠️ 仍待实现：① 按命中目标数分配给己方 N 个随机誓灵；② clearDebuffs 解除己方睡眠
    //    （`clearDebuffs` 这个字段服务端至今没有消费点）。
    "clearDebuffs": true,
    "statChanges": [
      {
        "target": "self",
        "prop": 105,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10193": {
    "id": 10193,
    "name": "人狼化形",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10194": {
    "id": 10194,
    "name": "蔽天之翼",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10196": {
    "id": 10196,
    "name": "冠世的琴声",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10202": {
    "id": 10202,
    "name": "嗜酒暴怒",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 40
      }
    ],
    "buffs": [
      {
        "target": "target",
        "buffId": 50008,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10203": {
    "id": 10203,
    "name": "指引之光",
    "effType": 1056,
    "type": 2,
    // desc：「30%几率提升1级魔攻；本回合在该技能后使用的光系技能，均会使指引之光使用者提升1级魔攻」
    // 原来配了两条（30% + 100%），且都写成 target —— 攻击技的 targets 是敌方，
    // 等于每次必给敌人 +1。第二条描述的是"**后续**光系技能触发"的联动，
    // 不应当场结算；联动本身尚未实现，先移除避免白送一层。
    "statChanges": [
      {
        "target": "self",
        "prop": 102,
        "delta": 1,
        "chance": 30
      }
    ]
  },
  "10205": {
    "id": 10205,
    "name": "春风之音",
    "effType": 1058,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 15
      }
    ]
  },
  "10208": {
    "id": 10208,
    "name": "勇者的激奏",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 50
      },
      {
        "target": "target",
        "prop": 105,
        "delta": -1,
        "chance": 50
      }
    ]
  },
  "10212": {
    "id": 10212,
    "name": "毒爆尘",
    "effType": 1058,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "10214": {
    "id": 10214,
    "name": "毒羽斩",
    "effType": 1007,
    "type": 1,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 30,
        "duration": 3
      }
    ]
  },
  "10220": {
    "id": 10220,
    "name": "圣盾强袭",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 50
      }
    ]
  },
  "10223": {
    "id": 10223,
    "name": "英雄之拳",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 10
      }
    ]
  },
  "10227": {
    "id": 10227,
    "name": "覆灭的狂涛",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 40
      }
    ]
  },
  "10231": {
    "id": 10231,
    "name": "披靡的烈风",
    "effType": 1058,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": -2,
        "chance": 100
      }
    ]
  },
  "10236": {
    "id": 10236,
    "name": "七之弹",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 105,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10241": {
    "id": 10241,
    "name": "冰之结界",
    "effType": 2099,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 105,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  // 米迦勒 10243 天国复仇：desc-AOE 族（调研-敌方AOE只打一人.md）。
  // 官方描述「无视攻击过己方的敌方誓灵的物防等级，若该次攻击击败了目标，则下次使用该技能
  // 能对目标之外的敌方全体造成100%的伤害」——全体追击不落 effType（1007 单体），靠
  // targetsOfEff 的 heavenVengeanceArmed 分支（settleSkill 尾段武装/清标）实现；
  // 防级无视走 settleSkill 命中段的 ignoreDefUpAttackedAlly 挂点（hitByServants 战斗内累计）。
  "10243": {
    "id": 10243,
    "name": "天国复仇",
    "effType": 1007,
    "type": 1,
    "heavenVengeance": true,
    "ignoreDefUpAttackedAlly": true
  },
  "10257": {
    "id": 10257,
    "name": "逆潮前涌",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 103,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 104,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10273": {
    "id": 10273,
    "name": "虚无爆发",
    "effType": 1058,
    "type": 2,
    // 「消耗当前所有虚空，每1点虚空提高1.5%的伤害，满虚空时会造成混乱(幻梦战时消耗当前一半虚空)」
    // ⚠️ 混乱是**有条件**的：只有施放前虚空=100 才施加（requireVoidFull，快照在 settleSkill 顶部取），
    //    与天赋 21910「虚空掌控」共用 void_energy 资源。见 调研-泡泡混乱.md。
    "voidBurst": { "dmgPerPoint": 0.015, "dreamKeepRatio": 0.5 },
    "buffs": [
      {
        "target": "target",
        "buffId": 50007,
        "chance": 100,
        "duration": 3,
        "requireVoidFull": true
      }
    ]
  },
  // 犹格·索托斯 10274 空间箭：desc-AOE 族（调研-敌方AOE只打一人.md）。
  // 「产生15点虚空，对敌方施加时空禁锢效果。满虚空下使用会降低敌方2级物防魔防并消耗50点虚空
  //  (幻梦战时为敌方全体添加时空禁锢效果)」——伤害本体是单体（1007）没错；缺的是：
  //  ① 禁锢 buff（12395，常态单体/幻梦战全体=dreamAll）；② 施放 +15 虚空；
  //  ③ 满虚空（施放前 ≥100）→ 降 2 级物防魔防并扣 50（requireVoidFullCast，快照在 settleSkill 顶部）。
  //  12395 的回合末供虚空（每层给对面 21910 +5）在 settleRoundEndTicks 的 buff tick 段。
  "10274": {
    "id": 10274,
    "name": "空间箭",
    "effType": 1007,
    "type": 2,
    "voidGain": 15,
    "fullVoidDefDown": { "levels": 2, "consume": 50 },
    "statChanges": [
      { "target": "target", "prop": 103, "delta": -2, "requireVoidFullCast": true },
      { "target": "target", "prop": 104, "delta": -2, "requireVoidFullCast": true }
    ],
    "buffs": [
      { "target": "target", "buffId": 12395, "chance": 100, "duration": 3, "dreamAll": true }
    ]
  },
  "10276": {
    "id": 10276,
    "name": "日照",
    "effType": 1058,
    "type": 1,
    "forceCrit": true,
    "statChanges": [
      {
        "target": "target",
        "prop": 101,
        "delta": -1,
        "chance": 100
      },
      {
        "target": "target",
        "prop": 103,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10282": {
    "id": 10282,
    "name": "鸽诺陶诺斯",
    "effType": 2002,
    "type": 3,
    "statChanges": [
      {
        "target": "target",
        "prop": 103,
        "delta": 1,
        "chance": 100
      },
      {
        "target": "target",
        "prop": 104,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10293": {
    "id": 10293,
    "name": "彩虹桥荣光",
    "effType": 1007,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10302": {
    "id": 10302,
    "name": "爱知给予",
    "effType": 1007,
    "type": 3,
    "statLevelCopy": true,
    "buffs": [
      {
        "target": "target",
        "buffId": 50005,
        "chance": 100,
        "duration": 3,
        "requireStatSum": 1
      }
    ]
  },
  "10308": {
    "id": 10308,
    "name": "天女咒",
    "effType": 1007,
    "type": 1,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 30,
        "duration": 3
      }
    ]
  },
  "10315": {
    "id": 10315,
    "name": "摩托冲撞",
    "effType": 1052,
    "type": 1,
    "statChanges": [
      {
        "target": "self",
        "prop": 105,
        "delta": -1,
        "chance": 100
      }
    ]
  },
  "10324": {
    "id": 10324,
    "name": "嫉灭之心",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 102,
        "delta": -2,
        "chance": 100
      }
    ]
  },
  "10327": {
    "id": 10327,
    "name": "黄印执掌",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50007,
        "chance": 100,
        "duration": 3,
        "requireYellowSign": true
      }
    ]
  },
  "10337": {
    "id": 10337,
    "name": "幻梦连接",
    "effType": 1007,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10340": {
    "id": 10340,
    "name": "深渊王权利 ",
    "effType": 1007,
    "type": 1,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 100,
        "duration": 3
      }
    ]
  },
  "10344": {
    "id": 10344,
    "name": "邪眼",
    "effType": 1056,
    "type": 2,
    "sleepOnCrit": 50,
    "buffs": [
      {
        "target": "target",
        "buffId": 50004,
        "chance": 50,
        "duration": 3
      }
    ]
  },
  "10349": {
    "id": 10349,
    "name": "熊熊妒火",
    "effType": 1058,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50002,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "10351": {
    "id": 10351,
    "name": "孤独吟唱",
    "effType": 2001,
    "type": 3,
    "statChanges": [
      {
        "target": "self",
        "prop": 101,
        "delta": 2,
        "chance": 100
      },
      {
        "target": "self",
        "prop": 105,
        "delta": 1,
        "chance": 100
      }
    ]
  },
  "10363": {
    "id": 10363,
    "name": "梦游仙境",
    "effType": 1058,
    "type": 1,
    // 基础版文案："20% 概率造成烧伤，睡眠状态下使用造成伤害提升 60%"
    // 原表第二条把 50004（睡眠）100% 施加给目标 —— 与文案不符（睡眠是"使用条件"，不是效果），已删除。
    "buffs": [
      {
        "target": "target",
        "buffId": 50002,
        "chance": 20,
        "duration": 3
      }
    ]
  },
  "90004": {
    "id": 90004,
    "name": "大地波动",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 104,
        "delta": -1,
        "chance": 20
      }
    ]
  },
  "90007": {
    "id": 90007,
    "name": "暴风雪",
    "effType": 1056,
    "type": 2,
    "buffs": [
      {
        "target": "target",
        "buffId": 50003,
        "chance": 10,
        "duration": 3
      }
    ]
  },
  "90009": {
    "id": 90009,
    "name": "泡沫之雨",
    "effType": 1007,
    "type": 2,
    "statChanges": [
      {
        "target": "target",
        "prop": 105,
        "delta": -1,
        "chance": 10
      }
    ]
  },
  // ── 暴击相关技能规则 ──
  "10033": {
    "id": 10033,
    "name": "融甲之爪",
    "effType": 1007,
    "type": 1,
    "forceCrit": true
  },
  "10057": {
    "id": 10057,
    "name": "巨石坠落",
    "effType": 1007,
    "type": 1,
    "skillCritStage": 2
  },
  "10127": {
    "id": 10127,
    "name": "风华破空枪",
    "effType": 1007,
    "type": 1,
    "skillCritStage": 2
  },
  "10167": {
    "id": 10167,
    "name": "沧海怒斩",
    "effType": 1007,
    "type": 1,
    "critOnResist": true,
    "negateResist": true
  },
  "10255": {
    "id": 10255,
    "name": "炙炎加沸",
    "effType": 1007,
    "type": 2,
    "critOnNature": 1
  },
  "10300": {
    "id": 10300,
    "name": "逆光贯雷",
    "effType": 1007,
    "type": 1,
    "skillCritStage": 2
  },
  "10347": {
    "id": 10347,
    "name": "全知全能",
    "effType": 2011,
    "type": 3,
    "critMulBonus": 0.30
  },

  // ---- 复合攻击技（攻击 + 伤害后回复/追加效果）----
  // 官方语义以 CfgSkillDetail.fightDesc 与 BWIKI 逐字核对（2026-10-05 零伤害修复）：
  // 旧实现把一切 healPct 技能当纯治疗（治疗目标并提前 return），这三个带威力的技能
  // 目标是敌方（effType 1xxx）→ 变成"给敌人回血（满血时无效）"，伤害永不结算。
  "10412": {
    "id": 10412,
    "name": "天之甘露",
    "effType": 1007,
    "type": 2,
    // "拥有暗系加成"：使用者(苏摩)为暗系时视作同属性技能（SkillConst.NATURE_ADDITION ×1.5）
    "darkSameBonus": true,
    // "造成伤害后恢复15%生命"：伤害结算后自身回复15%最大生命
    "postDamageHeal": { "selfPct": 15 },
    // "击败敌方单位时获得1层'血铠'"：与天赋 23140 的 bloodArmorLayers 共用计数
    "onKillBloodArmor": 1
  },
  "10406": {
    "id": 10406,
    "name": "蛋烧冲击",
    "effType": 1007,
    "type": 2,
    // "造成伤害后，为己方血量最低的角色恢复15%的生命"
    "postDamageHeal": { "lowestAllyPct": 15 }
  },
  "10218": {
    "id": 10218,
    "name": "重生之风",
    "effType": 1007,
    "type": 2,
    // "使用者回复造成伤害20%数值的生命，其余己方誓灵回复10%；乱流天气下回复效果翻倍"
    "postDamageHeal": { "userDealtPct": 20, "othersPct": 10, "doubleInWeather": 4 }
  },
  // ---- 动态威力 / 伤害后持续效果（hitRate=0 = 官方命中"—"= 无命中检定必中）----
  "10082": {
    "id": 10082,
    "name": "惩戒",
    "effType": 1007,
    "type": 2,
    // "对手能力等级越高威力越高"（BWIKI：威力 40~200；按目标正向能力等级和每级+40，封顶 200）
    "powerByTargetStatLv": { "base": 40, "perLv": 40, "cap": 200 }
  },
  "10077": {
    "id": 10077,
    "name": "终结之刃",
    "effType": 1007,
    "type": 1,
    // "次数越少威力越高"（每消耗 1 次威力 +40，封顶 200；与惩戒同型 40~200 区间）
    "powerByPpUsed": { "base": 40, "perUse": 40, "cap": 200 }
  },
  "10322": {
    "id": 10322,
    "name": "深渊狱火",
    "effType": 1007,
    "type": 1,
    // "造成伤害后，使目标与自身每回合损失各自最大生命值的20%，持续三回合"
    "afterDamageDrain": { "pct": 20, "rounds": 3, "includeSelf": true }
  }
  ,
  // ── P4 基础规则第一批（存档现役 17 条中此前空壳的 8 条）──
  // 数据源：tools/lua_sym/Config/CfgSkillDetail.lua 的 base fightDesc（非元素版）。
  "10006": { "id": 10006, "name": "仇恨吸引", "effType": 2001, "type": 3,
    // 本回合内对手所有单体技能转移到自身
    "tauntRounds": 1 },
  "10008": { "id": 10008, "name": "生命之泉涌", "effType": 2009, "type": 3,
    // 每回合回复 1/12 HP
    "springRounds": 5 },
  "10092": { "id": 10092, "name": "神之雫", "effType": 2002, "type": 3,
    // 随机一项能力上升 2 级
    "randomStat": { "target": "target", "count": 1, "delta": 2 } },
  "10110": { "id": 10110, "name": "心灵魔术", "effType": 1007, "type": 3,
    // 与目标交换所有能力等级变化
    "swapStats": true },
  "10130": { "id": 10130, "name": "无间轮回", "effType": 1007, "type": 2,
    // 目标生命低于 50% 时威力翻倍
    "dmgMulBelowHalf": 2.0 },
  "10002": { "id": 10002, "name": "法力屏障", "effType": 2099, "type": 3,
    // 5 回合内己方受到魔法伤害减少 1/3（元素版覆盖为 1/2）
    "magicBarrier": { "mul": 0.6667, "rounds": 5 } },
  "10204": { "id": 10204, "name": "月蚀斩", "effType": 1007, "type": 2,
    // 目标能力等级总和为负 → 伤害 +15%（夜幕 25%）
    "dmgMulByNegativeStatSum": { "base": 1.15, "night": 1.25 } },
  "10144": { "id": 10144, "name": "恩赐之泉", "effType": 2002, "type": 3,
    // 恢复 15% HP（skill_data.healPct）+ 随机一项能力 +1
    "randomStat": { "target": "target", "count": 1, "delta": 1 } },
  // ── P4 基础规则第二批（11 条）──
  "10128": { "id": 10128, "name": "巨神的豪腕", "effType": 1007, "type": 1,
    // 造成伤害后使用者下回合无法行动，沙尘天气除外
    "skipNextActionUnlessWeather": 1 },
  "10348": { "id": 10348, "name": "须佐的箭羽", "effType": 1007, "type": 1,
    // 被命中的誓灵下回合必定以大国主为目标
    "tauntRounds": 1 },
  "10134": { "id": 10134, "name": "穿魂击", "effType": 1007, "type": 1,
    // 使目标本回合内无法恢复生命（两版共用基础）
    "healBanAll": 1 },
  "10149": { "id": 10149, "name": "神圣祝福", "effType": 2001, "type": 3,
    // 3 回合内己方誓灵不会受到暴击
    "teamImmuneCritRounds": 3 },
  "10267": { "id": 10267, "name": "五龙奔袭", "effType": 1007, "type": 2,
    // 对水、火、风、土和暗属性誓灵造成 1.6 倍伤害
    "dmgMulByNature": { "natures": [1, 2, 3, 4, 6], "mul": 1.6 } },
  "10338": { "id": 10338, "name": "生魂刈割", "effType": 1007, "type": 1,
    // 伤害提升自身护盾值百分比的数值
    "dmgMulByShieldPct": 1 },
  "10330": { "id": 10330, "name": "绝境的希望", "effType": 1007, "type": 2,
    // 若敌方 HP 高于自身魔攻 → 伤害 +30%
    "dmgMulIfTargetHpAboveActorMagAtk": 1.3 },
  "10171": { "id": 10171, "name": "复仇风暴", "effType": 1007, "type": 2,
    // 计算伤害时取防御方较低的一项防御，且无视防御等级提升
    "lowerDef": true, "ignoreDefUp": true },
  "10355": { "id": 10355, "name": "五谷丰登", "effType": 1058, "type": 3,
    // 成功造成伤害后，己方所有土系誓灵随机提升 1 级能力等级
    "randomStat": { "target": "ally", "nature": 4, "count": 1, "delta": 1 } },
  "10301": { "id": 10301, "name": "拇指吸吮", "effType": 2001, "type": 3,
    // 物攻 +2、速度 +1
    "statChanges": [
      { "target": "self", "prop": 101, "delta": 2, "chance": 100 },
      { "target": "self", "prop": 105, "delta": 1, "chance": 100 }
    ] },
  "10379": { "id": 10379, "name": "环游世界", "effType": 1058, "type": 1,
    // 自身随机 2 项能力等级下降 2 级
    "randomStat": { "target": "self", "count": 2, "delta": -2 } },
  // ── P4 基础规则第三批（7 条）──
  "10376": { "id": 10376, "name": "灵魂画手", "effType": 1007, "type": 1,
    // 目标受伤害后，非 BOSS 单位 3 回合内使用技能时 20% 无法行动
    "soulPaintRounds": 3 },
  "10384": { "id": 10384, "name": "醉人的咖啡", "effType": 1007, "type": 1,
    // 目标 3 回合内治疗效果降低 50%，且每回合随机下降 1 级防御
    "healHalfRounds": 3, "randomDefDownRounds": 3 },
  "10395": { "id": 10395, "name": "光辉之剑", "effType": 1007, "type": 2,
    // 目标受到单体光系技能直接伤害时，对目标之外敌方造成同额伤害，持续 1 回合
    "lightSword": { "rounds": 1, "pct": 1.0 } },
  "10386": { "id": 10386, "name": "施恩", "effType": 2002, "type": 3,
    // 恢复 20% 生命；多余治疗量 → 对应角色随机 2 项能力 +1
    "overflowHealStat": 2 },
  "10382": { "id": 10382, "name": "突破逆境", "effType": 2001, "type": 3,
    // 回合结束时，己方随机 1 项能力 +1，持续 3 回合
    "roundEndAllyRandom": 3 },
  "10378": { "id": 10378, "name": "心算", "effType": 2001, "type": 3,
    // 造成伤害时取敌方较低防御；每回合暴击 +1，持续 4 回合
    "lowerDef": true, "roundEndStat": { "prop": 111, "delta": 1, "rounds": 4 } },
  "10200": { "id": 10200, "name": "燥热的阳炎", "effType": 1007, "type": 2,
    // 烈日天气下技能变为必中
    "sureHitWeather": 3 },
  // ── P4 基础规则第四批（8 条）──
  "10271": { "id": 10271, "name": "根源恐惧", "effType": 1007, "type": 2,
    // 对非混沌阵营誓灵造成伤害时，其魔防下降 1 级
    "statChanges": [ { "target": "target", "prop": 104, "delta": -1, "chance": 100, "notCamp": 26 } ] },
  "10294": { "id": 10294, "name": "载世宝船", "effType": 2001, "type": 3,
    // 提升目标较高攻击 1 级及随机 1 项除攻击外能力 1 级（随机项近似）
    "randomStat": { "target": "target", "count": 1, "delta": 1 } },
  "10369": { "id": 10369, "name": "可爱、打钱", "effType": 1007, "type": 2,
    // 每名敌方角色随机 2 项能力 -1
    "randomStat": { "target": "target", "count": 2, "delta": -1 } },
  "10428": { "id": 10428, "name": "雪牢", "effType": 1052, "type": 2,
    // 若目标速度比自身高，计算伤害前降 2 级速度，否则伤害后降 1 级（近似为 -1）
    "statChanges": [ { "target": "target", "prop": 105, "delta": -1, "chance": 100 } ] },
  "10374": { "id": 10374, "name": "母河庇佑", "effType": 2002, "type": 3,
    // 造成伤害前使己方全体立即获得 10% 护盾
    "teamShieldPct": 10 },
  "10381": { "id": 10381, "name": "狂野紫电", "effType": 1007, "type": 2,
    // 对有正向能力等级的目标造成伤害提升 50%
    "dmgMulIfTargetStatSumPositive": 1.5 },
  "10380": { "id": 10380, "name": "军刀突刺", "effType": 1007, "type": 1,
    // 目标接下来受到的三次伤害会被无视正向防御等级
    "defPierceOnHit": 3 },
  "10410": { "id": 10410, "name": "红豆魔法", "effType": 1007, "type": 2,
    // 每击败一名敌方角色，己方其余角色随机提升 1 项能力等级
    "onKillAllyStat": { "count": 1, "delta": 1 } },
  // ── P4 基础规则第五批（8 条）──
  "10256": { "id": 10256, "name": "浊浪激流", "effType": 1007, "type": 2,
    // 伤害提升 40%
    "dmgMulFixed": 1.4 },
  "10154": { "id": 10154, "name": "光速之拳", "effType": 1007, "type": 1,
    // 本回合第一个造成技能伤害 → 物攻与随机 1 项防御 +2
    "firstDmgStat": true },
  "10150": { "id": 10150, "name": "圣光之矢", "effType": 1007, "type": 2,
    // 目标下回合无法使用本回合使用过的技能
    "skillLock": true },
  "10329": { "id": 10329, "name": "简单维修", "effType": 2002, "type": 3,
    // 清除目标负面能力等级，本回合能力不下降，且目标下次不会被击倒
    "clearNegativeTarget": true, "noKnockdown": 1 },
  "10359": { "id": 10359, "name": "生死审判", "effType": 1007, "type": 2,
    // 目标成为轮回判决对象（不获增益），持续 2 回合
    "judgment": 2 },
  "10343": { "id": 10343, "name": "蔑视", "effType": 1007, "type": 1,
    // 攻击时视作等级 +20；同时获得天赋两种效果
    "levelOverride": 20, "talentBoth": true },
  "10068": { "id": 10068, "name": "苍天之拳", "effType": 1007, "type": 2,
    // 可破坏对方屏障和绝对防御效果
    "breakBarrier": true },
  "10140": { "id": 10140, "name": "涌动之拳", "effType": 1007, "type": 2,
    // 可破坏对方屏障和绝对防御效果
    "breakBarrier": true },
  // ── P4 基础规则第六批（4 条）──
  "10248": { "id": 10248, "name": "疫症播衍", "effType": 1007, "type": 2,
    // 击杀敌方后，其负面状态由随机队友继承
    "onKillInheritDebuff": true },
  "10249": { "id": 10249, "name": "鏖战入狂", "effType": 1007, "type": 2,
    // 造成伤害后，自己和敌方下回合都不能使用辅助技能
    "supportBanBoth": 2 },
  "10356": { "id": 10356, "name": "丰满的麦穗", "effType": 2011, "type": 3,
    // 扣除自身当前 25% 生命，使己方全体提升 3 项能力等级 1 级
    "selfHpCostPct": 25, "randomStat": { "target": "ally", "count": 3, "delta": 1 } },
  "10377": { "id": 10377, "name": "动物退散", "effType": 1007, "type": 3,
    // 吸引目标 3 回合内的单体攻击；非单体技能 → 随机防御 -1
    "tauntRounds": 3, "animalRepel": 3 },
  // ── P4 基础规则第七批（9 条）──
  "10304": { "id": 10304, "name": "摩竭之噬", "effType": 1007, "type": 2,
    // 当前回合清除敌方所有能力等级，下一回合对其攻击（延时类）
    // stripPositive 原为本字段隐含行为，H3 起显式化（10260 极限预读共用 delayStrike 但不剥等级）
    "delayStrike": { "power": 1, "stripPositive": true } },
  "10362": { "id": 10362, "name": "小矮人救援", "effType": 1007, "type": 2,
    // 伤害 +80%，对同属性产生克制；造成克制时随机防御 +1
    "dmgMulFixed": 1.8, "relOverrideSameNature": true, "onResistStat": { "randomDef": 1 } },
  "10408": { "id": 10408, "name": "绿葱蘸酱", "effType": 1007, "type": 2,
    // 对水火属性克制；造成克制后较高攻和速度 +1
    "relOverrideNature": [1, 2], "onResistStat": { "higherAtk": 1, "speed": 1 } },
  "10366": { "id": 10366, "name": "轰击五星", "effType": 1007, "type": 2,
    // 成功造成伤害后，随机对 4 名敌方造成本次伤害 20%
    "splashRandom": { "count": 4, "pct": 0.20 } },
  "10368": { "id": 10368, "name": "二次冻结", "effType": 1007, "type": 2,
    // 成功造成伤害后额外造成本次伤害 45%
    "splashRandom": { "count": 1, "pct": 0.45 } },
  "10370": { "id": 10370, "name": "循环擦盘子", "effType": 1007, "type": 2,
    // 伤害提升 X%（X=敌方平均失去血量百分比）
    "dmgMulByEnemyMissingHp": true },
  "10420": { "id": 10420, "name": "朝圣之路", "effType": 1007, "type": 2,
    // 造成伤害后，目标下次伤害 -n*10%，己方全体下次伤害 +n*20%
    "nextOutDownByNatureCount": { "pct": 0.10, "allyMul": 2 } },
  "10423": { "id": 10423, "name": "命悬一线", "effType": 2001, "type": 3,
    // 天赋触发血线与伤害 15%→20%，持续 2 回合
    "talentParam": { "hpLine": 0.20, "dmg": 0.20 } },
  "10411": { "id": 10411, "name": "喷涌的馅料", "effType": 1007, "type": 2,
    // 成功造成伤害后，再次对中毒/烧伤单位造成 100% 伤害
    "repeatOnStatus": { "statuses": [50002, 50005], "pct": 1.0 } },
  // ── P4 基础规则第八批（10 条）──
  "10029": { "id": 10029, "name": "黄泉逆流", "effType": 1007, "type": 2,
    // 对光属性可造成克制
    "relOverrideNature": [5] },
  "10303": { "id": 10303, "name": "传说颂唱", "effType": 2001, "type": 3,
    // 使用后，除自身外的友方阿瓦隆誓灵较高攻与较低防 +1
    "allyCampStat": { "camp": 12, "changes": [ { "prop": 101, "delta": 1 }, { "prop": 104, "delta": 1 } ] } },
  "10331": { "id": 10331, "name": "警觉射击", "effType": 1007, "type": 2,
    // 基础版：若敌方对千户存在攻击意图（= 该敌方的意图主目标是千户 3245001）→ 伤害 +50%；
    // 元素版（3242002 唤醒中）另认尤莉且目标不被改变，走 fight_core 专属乘区 case 10331
    "dmgMulIfAimsAt": { "types": [3245001], "mul": 1.5 } },
  "10333": { "id": 10333, "name": "国土一掷", "effType": 1007, "type": 2,
    // 未命中时，对敌方随机一名其余誓灵造成伤害
    "missSplash": true },
  "10336": { "id": 10336, "name": "暗夜主宰", "effType": 2001, "type": 3,
    // 使用后自身 4 回合不被克制、不被暴击，受到伤害吸取 20% 当前生命
    "nightLord": 4 },
  "10372": { "id": 10372, "name": "反核弹外壳", "effType": 2002, "type": 3,
    // 消耗自身 20% 最大生命；本回合首次受伤降至 1 并反弹
    "nukeShell": true },
  "10383": { "id": 10383, "name": "三色宝石", "effType": 1058, "type": 2,
    // 目标随机进入烧伤/麻痹/中毒
    "randomBuff": true },
  "10385": { "id": 10385, "name": "兔子退散", "effType": 1007, "type": 2,
    // 击败敌方则额外施放一次
    "refireOnKill": true },
  "10387": { "id": 10387, "name": "光熊之拳", "effType": 1007, "type": 2,
    // 伤害前己方全体损失当前 15% 生命，伤害后回复上限 3%
    "lightBear": true },
  "10407": { "id": 10407, "name": "甜蜜梦境", "effType": 1007, "type": 2,
    // 目标下次受到非光属性伤害时双防 -1
    "sweetDreamNext": true },
  // ── P4 基础规则第九批（11 条）──
  "10123": { "id": 10123, "name": "灭世的海啸", "effType": 1007, "type": 2,
    // 造成伤害后使用者下回合无法行动，暴雨天气除外
    "skipNextActionUnlessWeather": 2 },
  "10268": { "id": 10268, "name": "挥鞭击流", "effType": 1007, "type": 1,
    // 伤害前随机提升 1 级物攻或速度，伤害后再提升一次
    "randomStat": { "target": "self", "count": 1, "delta": 1 }, "postDamageRandomStat": 1 },
  "10297": { "id": 10297, "name": "沐雨之祈", "effType": 2001, "type": 3,
    // 使用后若己方誓灵都携带气象石-雨 → 天气变为暴雨
    "weatherIfAllStone": 2 },
  "10299": { "id": 10299, "name": "耀雨之光棘", "effType": 1007, "type": 2,
    // 使用后对自身造成 1/3 威力伤害；圣光天气下无副作用
    "selfDamageThird": true },
  "10307": { "id": 10307, "name": "诸天主宰", "effType": 1007, "type": 2,
    // 消耗所有天之赐，每层伤害 +4% 且临时暴击 +1
    "skyGiftConsume": true },
  "10332": { "id": 10332, "name": "末世的乐观", "effType": 2001, "type": 3,
    // 清除自身所有负面能力等级，每清除一级下次受伤 -50%
    "clearNegativeSelf": true, "nextInDmgDownPerClear": 0.5 },
  "10352": { "id": 10352, "name": "魔法锅", "effType": 1058, "type": 3,
    // 清除目标所有负向能力等级，己方全体提升相同级数相同属性
    "clearNegativeTarget": true, "teamGainCleared": true },
  "10367": { "id": 10367, "name": "骚动的绵羊", "effType": 2001, "type": 3,
    // 较高攻和随机防御 +2；回合结束时随机能力 -1，持续 2 回合
    "randomStat": { "target": "self", "count": 2, "delta": 2 }, "roundEndRandomDebuff": 2 },
  "10392": { "id": 10392, "name": "万物的誓言", "effType": 2001, "type": 3,
    // 抵抗非同属性技能、被同属性克制，持续 3 回合
    "stance": { "rounds": 3, "kind": "resist_non_same" } },
  "10396": { "id": 10396, "name": "虚伪的装束", "effType": 2001, "type": 3,
    // 抵抗与敌方誓灵相同属性的攻击，持续 2 回合
    "stance": { "rounds": 2, "kind": "resist_same_enemy" } },
  "10409": { "id": 10409, "name": "高温烘烤", "effType": 1007, "type": 2,
    // 造成伤害后使其中毒或烧伤，且下回合能力下降翻倍
    "randomBuff": true, "debuffDouble": 1 },
  // ── P4 基础规则第十批（最后 3 条复杂项）──
  "10371": { "id": 10371, "name": "水神抄本", "effType": 1007, "type": 2,
    // 该次攻击可攻击到与克塔亚特产生接触融合的角色
    "attackFusion": true },
  "10404": { "id": 10404, "name": "文火慢炖", "effType": 2001, "type": 3,
    // 回合末扣 15% 护盾、较高攻速 +1，持续 5 回合；护盾不足则全扣并使下次护盾翻倍
    "slowCookBase": { "rounds": 5, "pct": 15 } },
  "10405": { "id": 10405, "name": "水燕飞花", "effType": 1007, "type": 2,
    // 连续攻击 3 次；随机 2 名敌方物防 -1，己方 2 名角色物攻 +1
    "extraHits": { "count": 2, "pct": 1.0 }, "randomFoeDefDown": 2, "randomAllyAtkUp": 2 },
  // ── 批次B 模板族（二百五十一）：fightDesc 为需求文档，概率/数值官方无配置的自定基线在注释标注 ──
  "10001": { "id": 10001, "name": "力量屏障", "effType": 2099, "type": 3,
    // 「5回合内己方受到物理伤害减少1/3」——与法力屏障 10002 同构，物理版此前整条漏配
    "phyBarrier": { "mul": 0.6667, "rounds": 5 } },
  "10034": { "id": 10034, "name": "炎王之拳", "effType": 1007, "type": 1,
    // 「30%几率使目标畏惧」
    "chanceFlinch": 30 },
  "10053": { "id": 10053, "name": "气刃斩", "effType": 1007, "type": 2,
    // 「30%几率使目标畏惧」
    "chanceFlinch": 30 },
  "10056": { "id": 10056, "name": "岩锥", "effType": 1056, "type": 1,
    // 「30%几率使目标畏惧」
    "chanceFlinch": 30 },
  "10079": { "id": 10079, "name": "邪神之爪", "effType": 1007, "type": 1,
    // 「20%几率使目标畏惧」
    "chanceFlinch": 20 },
  "10389": { "id": 10389, "name": "鹿鸣", "effType": 1058, "type": 2,
    // 「有20%概率造成混乱」
    "buffs": [{ "buffId": 50007, "chance": 20, "duration": 3 }] },
  "10182": { "id": 10182, "name": "苍穹的龙舞", "effType": 1007, "type": 2,
    // 「使用后随机1项能力提升1级」
    "randomStat": { "target": "self", "count": 1, "delta": 1 } },
  "10287": { "id": 10287, "name": "成熟的玉米", "effType": 1058, "type": 2,
    // 「50%随机降低敌方一项能力等级」
    "randomStat": { "target": "target", "count": 1, "delta": -1, "chance": 50 } },
  "10290": { "id": 10290, "name": "轻羽之扫", "effType": 1007, "type": 2,
    // 「造成伤害后降低敌方随机两项正向能力等级一级」（负等级不可再降，gainStat 钳制自然吞掉）
    "randomStat": { "target": "target", "count": 2, "delta": -1 } },
  "10292": { "id": 10292, "name": "绝望蔓延", "effType": 1007, "type": 2,
    // 「随机降低敌方某项能力等级2级」
    "randomStat": { "target": "target", "count": 1, "delta": -2 } },
  // ── 批次C/D（二百五十二）：吸血/护盾/等级操作 ──
  "10131": { "id": 10131, "name": "血腥屠戮", "effType": 1007, "type": 1,
    // 「恢复造成伤害50%的生命」
    "postDamageHeal": { "userDealtPct": 50 } },
  "10192": { "id": 10192, "name": "祝福的琴声", "effType": 1058, "type": 1,
    // 「使用者回复对敌方造成伤害的35%HP」
    "postDamageHeal": { "userDealtPct": 35 } },
  "10345": { "id": 10345, "name": "嗜血蝇群", "effType": 1058, "type": 2,
    // 「为己方全体恢复造成伤害20%的生命」（含使用者，各自按总伤计）
    "postDamageHeal": { "alliesDealtPct": 20 } },
  "10234": { "id": 10234, "name": "炎盾创造", "effType": 1058, "type": 2,
    // 「使用后，己方誓灵获得最大生命值5%的护盾」
    "teamShieldPct": 5 },
  // ── 批次E 优先度系（二百五十三）：优先度本身在 fight_core.SKILL_PRIO_TABLE，此处只挂伤害条件 ──
  "10179": { "id": 10179, "name": "百炼之拳", "effType": 1007, "type": 1,
    // 「若使用者上回合被攻击技能伤害，则伤害提升30%，技能优先度+1」（优先度条件在 SKILL_PRIO_TABLE）
    "dmgMulIfHitLastRound": 1.30 },
  "10258": { "id": 10258, "name": "沧海遗泪", "effType": 1058, "type": 2,
    // 「该技能优先度-1；本回合敌方每对自己造成一次伤害，该技能伤害提升50%」（优先度在 SKILL_PRIO_TABLE）
    "dmgMulPerHitTakenThisRound": 0.50 },
  "10195": { "id": 10195, "name": "战鼓之音", "effType": 2002, "type": 3,
    // 「目标下回合的声音技能提升20%伤害，提升2级优先度」（消费：声音段乘区 + applySkillPriorities）
    "nextSoundBoost": { "dmg": 0.20, "prio": 2 } },
  // ── 批次F 状态标记族（二百五十四）：纯辅助技必须有规则条目，否则 applySkillEffects 在 `if (!rule) return` 前拦截 ──
  "10390": { "id": 10390, "name": "捣药", "effType": 2002, "type": 3,
    // 「消耗目标的长生药，使其全部能力等级提升2级并在3回合内无法被降低能力等级」
    "lifePill": true },
  "10318": { "id": 10318, "name": "海星狂热", "effType": 2009, "type": 3,
    // 「使目标进入海星狂热状态，下次使用任意技能前消耗全部海星，每消耗1个伤害+30%」
    "starfishFrenzy": true },
  "10269": { "id": 10269, "name": "凝视", "effType": 1007, "type": 3,
    // 「使目标进入凝视状态2回合，期间不能使用进入前最后使用的招式」
    "gazeLock": true },
  "10313": { "id": 10313, "name": "连续飞踢", "effType": 1007, "type": 1,
    // 「造成伤害后，为目标添加浮空状态一回合。敌方处于浮空状态时，被攻击必定暴击」
    "floatOnHit": true },
  "10275": { "id": 10275, "name": "如影随形", "effType": 1056, "type": 1,
    // 「造成伤害后留下风行者印记，此后每次使用该技能对拥有印记者额外+50%」
    "windWalkerMark": true },
  "10418": { "id": 10418, "name": "杀戮波动", "effType": 1007, "type": 1,
    // 「对拥有血污的目标再次造成 n*16% 的伤害」
    "bloodStainBonus": true },
  "10350": { "id": 10350, "name": "八上的诅咒", "effType": 1007, "type": 2,
    // 「给目标添加2层哀叹，且阻止目标下回合能力等级提升（3回合只能生效一次）」
    "lamentCurse": true },
  "10394": { "id": 10394, "name": "裁决", "effType": 1058, "type": 2,
    // 「目标有法典→较高攻-1；否则较低攻+1」
    "verdict": true },
  // ── 批次G-2/G-3（二百五十六）──
  "10346": { "id": 10346, "name": "电浆喷射", "effType": 1007, "type": 1,
    // 「消耗所有电浆能量，每点 +25% 伤害，且随机降低一项防御等级1级」
    "plasmaBurst": true },
  "10357": { "id": 10357, "name": "西兰岛之殇", "effType": 1007, "type": 1,
    // 「每造成目标 15% 最大生命的伤害，随机夺取 1 级正向能力等级」
    "stealStatPerHpPct": 15 },
  "10060": { "id": 10060, "name": "崩岩粉碎拳", "effType": 1007, "type": 1,
    // 「沙尘天气时，可对目标周围造成 50% 伤害」
    "sandstormSplashPct": 0.50 },
  "10049": { "id": 10049, "name": "风神破-疾", "effType": 1007, "type": 1,
    // 「自己比对手速度越高，威力越高」
    "dmgMulBySpeedDiff": true },
  // ── 阻挡族（G-3）：官方无「阻挡」状态，近似为「目标本回合已行动」──
  // 取证见 调研-批次G复杂特殊条目.md §2：CfgBuff 无此状态、客户端 Lua 全库仅命中技能描述文本。
  "10025": { "id": 10025, "name": "深海潜行", "effType": 1007, "type": 1, "dmgMulVsActed": 1.30 },
  "10047": { "id": 10047, "name": "天空击", "effType": 1007, "type": 1, "dmgMulVsActed": 1.30 },
  "10058": { "id": 10058, "name": "遁地术", "effType": 1007, "type": 1, "dmgMulVsActed": 1.30 },
  "10064": { "id": 10064, "name": "泥炼成-枪", "effType": 1052, "type": 2, "dmgMulVsActed": 1.50 },
  "10397": { "id": 10397, "name": "高傲的独角", "effType": 1052, "type": 2,
    // 「对被阻挡目标威力提升20%，造成伤害后将目标随机2项正向等级清除」
    "dmgMulVsActed": 1.20,
    "randomStat": { "target": "target", "count": 2, "delta": -1 } },
  // ── 批次H1：单字段/已有基建复用族（调研-技能侧剩余特效补齐.md gap_T1 24 条 + 10104/10121）──
  "10004": { "id": 10004, "name": "结界盾", "effType": 2099, "type": 3,
    // 「本回合内己方不受群体技能伤害」——己方全体 aoeImmuneRounds=1（消费在 settleSkill 攻击分支，
    // 敌方群体技伤害归零；piercing 见 10139 波动斩，H2 批次取证后接）
    "teamAoeImmuneRounds": 1 },
  "10005": { "id": 10005, "name": "回复封印", "effType": 1007, "type": 3,
    // 「5回合内无法回复HP」——完全禁疗走 healBlockRounds（×0）。
    // ⚠️ 修正调研文档的复用声明：healBanRounds 是 ×0.25 软禁疗（10134/10384 既有口径），
    //    "无法回复HP" 的官方语义必须用 healBlockRounds（10130 无间轮回同通道）
    "healBlockRounds": 5 },
  "10009": { "id": 10009, "name": "疾走之风", "effType": 2099, "type": 3,
    // 「4回合内己方速度翻倍」——effectiveSpeed ×2，回合末递减（施放回合算第 1 回合，与 magicBarrier 同口径）
    "teamSpeedMulRounds": 4 },
  "10052": { "id": 10052, "name": "连环风刃", "effType": 1007, "type": 2,
    // 「连续攻击2-5次」——extraHits 支持 countRange 随机段数
    "extraHits": { "countRange": [2, 5], "pct": 1 } },
  "10104": { "id": 10104, "name": "激怒", "effType": 1007, "type": 3,
    // 「在3回合内无法使用辅助技能」——目标侧禁辅（区别于 supportBanBoth 的双方全员）
    "supportBanTargetRounds": 3 },
  "10121": { "id": 10121, "name": "陨石暴击", "effType": 1007, "type": 1,
    // 「本回合若没有命中，下回合变为必中」——miss 时记 nextSureHit{round+1,skillId}，下回合同技能必中
    "sureHitAfterMiss": true },
  "10159": { "id": 10159, "name": "弹幕：福利", "effType": 1007, "type": 1,
    // 「连续攻击2次」
    "extraHits": { "count": 2, "pct": 1 } },
  "10169": { "id": 10169, "name": "崇高的光耀", "effType": 1007, "type": 2,
    // 「可对风属性造成克制效果」
    "relOverrideNature": [3] },
  "10173": { "id": 10173, "name": "元素融合", "effType": 2001, "type": 3,
    // 「使用后自身所有攻击技能都拥有本属性修正且克制伤害提升30%」——
    // actor.fusionActive 持续到战斗结束（官方无持续回合描述）；同属性修正在 same 段消费、
    // 克制增伤在乘区段消费（rel===1 时 ×1.3）
    "fusionSelf": true },
  "10187": { "id": 10187, "name": "精灵之音", "effType": 2009, "type": 3,
    // 「目标下次使用声音类技能时伤害提升50%，且无视敌方的防御等级提升」——
    // 复用战鼓之音 nextSoundBoost 通道（{dmg} 一次性），扩展 ignoreDefLvUp（下次声音技无视对方正向防御等级）
    "nextSoundBoost": { "dmg": 0.5, "ignoreDefLvUp": true } },
  "10197": { "id": 10197, "name": "欧气传输", "effType": 2002, "type": 3,
    // 「目标下次技能伤害提升10%，35%，80%，150%的其中一个」——四选一随机，nextOutDmgUp 一次性消耗
    "nextOutDmgUpChoices": [0.10, 0.35, 0.80, 1.50] },
  "10206": { "id": 10206, "name": "千年的赞歌", "effType": 1007, "type": 2,
    // 「连续攻击1-3次」
    "extraHits": { "countRange": [1, 3], "pct": 1 } },
  "10209": { "id": 10209, "name": "回溯之剑", "effType": 1056, "type": 1,
    // 「若使用者上回合受到过来自目标的技能伤害，该技能对其伤害提升35%」——
    // 需要按来源记录：受击记 hitFromThisRound[来源id]，回合末快照 hitByFromLastRound
    "dmgMulIfHitByTargetLastRound": 1.35 },
  "10211": { "id": 10211, "name": "时越狙击", "effType": 1007, "type": 2,
    // 「造成伤害后，使用者下回合对该目标伤害提升25%」——per-target 版 nextRoundDmgUp（round 门控）
    "nextRoundDmgUpVsTarget": 0.25 },
  "10221": { "id": 10221, "name": "月耀连射", "effType": 1007, "type": 1,
    // 「连续攻击1-2次」
    "extraHits": { "countRange": [1, 2], "pct": 1 } },
  "10224": { "id": 10224, "name": "正义之星", "effType": 2002, "type": 3,
    // 「目标下次攻击伤害提升50%，若目标能力等级总和为负，每1级额外提供50%的伤害」
    "nextOutDmgUpByNegStat": { "base": 0.5, "perLevel": 0.5 } },
  "10244": { "id": 10244, "name": "神明启示", "effType": 2002, "type": 3,
    // 「使用后，下次攻击的目标不会改变，且必定产生暴击，暴击伤害提升35%」——
    // 目标（effType 2002 己方单体）获得：skillTargetLocked（目标锁，压过霍德尔/嘲讽/挑拨）
    // + nextAttackForceCrit（下次攻击必暴）+ nextAttackCritDmgUp（爆伤+35%），下次攻击技施放时消费
    "nextAttackCritLock": { "critDmgUp": 0.35 } },
  "10168": { "id": 10168, "name": "兴奋的秘泉", "effType": 2002, "type": 3,
    // 「目标速度和伤害翻倍，回合结束时损失最大生命的20%，持续3回合」——
    // 3 回合（施放回合算第 1 回合）；速度在 effectiveSpeed、伤害在 settleSkill 乘区；
    // 回合末在 settleRoundEndTicks 扣血并递减，到期发 11502「兴奋的秘泉消失」。
    "exciteSpring": { "rounds": 3, "hpLossPct": 20, "dmgMul": 2, "speedMul": 2 } },
  "10251": { "id": 10251, "name": "欲望激发", "effType": 2002, "type": 3,
    // 「使目标誓灵较高一项攻击能力上升2级」——statChanges 扩展 prop:'higherAtk'（按目标 attrs 动态解析）
    "statChanges": [{ "target": "target", "prop": "higherAtk", "delta": 2 }] },
  "10266": { "id": 10266, "name": "弱者的反击", "effType": 1007, "type": 1,
    // 「使用后降低使用者正向能力等级（最多降低4级），每降低一级本技能伤害提升30%」——
    // 施放时降自身正向等级（8 项属性全算），本次技能乘 (1 + 0.3×降低数)
    "selfDropPositiveForDmg": { "maxDrop": 4, "perLevel": 0.3 } },
  "10288": { "id": 10288, "name": "萌虎拍击", "effType": 1056, "type": 1,
    // 「30%使目标畏惧」
    "chanceFlinch": 30 },
  "10298": { "id": 10298, "name": "炎毒暗阳", "effType": 1007, "type": 2,
    // 「对风、水系誓灵伤害额外提升40%」
    "dmgMulByNature": { "natures": [1, 3], "mul": 1.4 } },
  "10311": { "id": 10311, "name": "演剧部之声", "effType": 1058, "type": 2,
    // 「场上每存在一名clannad阵营誓灵（包括敌方），伤害提升20%」
    "dmgMulPerClannad": 0.2 },
  "10317": { "id": 10317, "name": "风子参上", "effType": 2002, "type": 3,
    // 「对目标使用技能后，目标下次伤害提升70%，且无视行动顺序立刻行动」——
    // ⚠️ 部分实现：+70% 伤害走 nextOutDmgUp 一次性通道；「无视行动顺序立刻行动」需要行动队列
    //    中途插队（三个 handler 的行动循环都是预先排序的数组），留待 H3 回合状态机族统一处理
    "nextOutDmgUp": 0.7 },
  "10398": { "id": 10398, "name": "舍命奋进", "effType": 1007, "type": 1,
    // 「使用技能后自身本回合受到伤害提升40%；对火系誓灵造成伤害提升40%」——
    // 对火 +40% 走 dmgMulByNature；自身受伤 +40% 走 inDmgUpRounds 通用通道（回合末递减）
    "dmgMulByNature": { "natures": [2], "mul": 1.4 },
    "selfInDmgUp": { "rounds": 1, "pct": 0.4 } },
  "10403": { "id": 10403, "name": "时序之风", "effType": 1058, "type": 2,
    // 「对能力等级全部为0的目标造成伤害提升50%」——严格口径：五项基础能力等级全部为 0
    "dmgMulIfTargetStatSumZero": 1.5 },
  "10415": { "id": 10415, "name": "囚世地牢", "effType": 1058, "type": 2,
    // 「对敌方场地生命最高的角色造成伤害提升30%且目标当前回合无法提升能力等级」
    "dmgMulIfTargetTopHp": 1.3,
    "noPositiveTargetRounds": 1 },
  "10425": { "id": 10425, "name": "罪孽判决", "effType": 1007, "type": 2,
    // 「可对光属性誓灵造成克制伤害；使己方生命少于50%的角色下次受到的技能伤害减少30%」——
    // 后半走 nextInDmgDown 一次性通道（3916 消费）
    "relOverrideNature": [5],
    "lowHpAllyInDmgDown": 0.3 },
  // ── 批次H2：屏障免疫体系（取证见工作日志二百六十二）──
  "10007": { "id": 10007, "name": "绝对防御", "effType": 2001, "type": 3,
    // 「本回合内能免疫大部分技能」——自 target；敌方技能（伤害 + 追加效果）不生效，
    // 己方技能不受影响；DoT/回合末效果非"技能"自然穿透。
    // 「大部分」的例外（三路取证）：技能池内只有 10139 波动斩穿透；10068/10140 破坏；
    // 其余穿透者全是 boss 光环 80xxx（CfgBuff，不属技能池）。
    // 「连续使用容易失败」官方无数值 → Protect 式近似（第2次50%、第3次25%…）。
    // 优先度+4 在 SKILL_PRIO_TABLE（百度百科/官方观察数据）。
    "absoluteDef": true },
  "10139": { "id": 10139, "name": "波动斩", "effType": 1056, "type": 1,
    // 「可击中绝对防御和结界盾中的目标」——同时穿透两套免疫（fightDesc 实证）
    "pierceAoeImmune": true,
    "pierceAbsoluteDef": true },
  "90003": { "id": 90003, "name": "结界盾(NPC)", "effType": 2099, "type": 3,
    // NPC 版结界盾（Skill.lua 同 fightAct 1000401），语义与 10004 完全一致
    "teamAoeImmuneRounds": 1 },
  // ── 批次H3：回合状态机族（owners≥4 优先 + 延时基础版；沿用 per-unit 标记 + 回合末递减的既有惯例）──
  "10003": { "id": 10003, "name": "心灵暗示", "effType": 1007, "type": 3,
    // 「接下来3次只能使用最后使用的技能」——目标侧 mindShackleCount 计数制（非回合制），
    // 锁定技 = 目标 lastUsedSkill（settleSkill 顶部统一记录；从未用过 → 不设限）。
    // 消费：aiChoose 可用集过滤 + map_fight 手动路径强制改选；生效特性 10021（FightFeature）
    "mindShackle": 3 },
  "10015": { "id": 10015, "name": "狩猎标记", "effType": 1007, "type": 3,
    // 「下一回合对目标的技能必定命中」——施放者 nextSureHitVs{targetId, round+1}（命中段消费）
    "nextSureHitVsTarget": true },
  "10116": { "id": 10116, "name": "圣器封印", "effType": 1007, "type": 1,
    // 「使目标在本场战斗中失去圣器」——一次性删除目标全部 relic* 字段 + relicSealed 挡圣器共享重挂；
    // 单位按战斗重建 ⇒ 无需恢复路径。生效特性 10801（FightFeature「#tar的圣器效果被封印了！」）
    "sealRelic": true },
  "10117": { "id": 10117, "name": "聚力击", "effType": 1007, "type": 1,
    // 「连续使用每回合威力翻倍，中断或未命中重置」——focusStrikeStreak 计数；威力 ×2^min(streak,3)，
    // 上限 ×8 为防失控近似（官方无上限数值）；换技中断 / miss 重置
    "powerDoublePerUse": { "max": 3 } },
  "10259": { "id": 10259, "name": "全局推演", "effType": 2001, "type": 3,
    // 「经过一回合的准备时间，第二回合结束时技能使用者全部能力等级上升两级（延时类技能）」——
    // globalDeductionAt = 施放回合+1，settleRoundEndTicks 命中回合时全属性 +2
    "roundEndSelfStatUp": { "delay": 1, "delta": 2 } },
  "10260": { "id": 10260, "name": "极限预读", "effType": 1007, "type": 2,
    // 「下一回合结束时对敌方造成伤害；若自身还在场，额外造成50%伤害（延时类技能，不计算克制抵抗）」——
    // 沿用 10304 摩竭之噬家族口径（本回合照常出伤 + delayStrike 下回合追击）；
    // 追击只在施放者存活时执行 ⇒「额外50%」并入 power 1.5；「不计算克制抵抗」未近似（追击走 rel）
    "delayStrike": { "power": 1.5 } },
  "10261": { "id": 10261, "name": "天击", "effType": 1058, "type": 2,
    // 「造成伤害后下一回合攻击者无法使用攻击技能」——施放者 noAttackRounds=1（回合末递减）；
    // 消费：aiChoose 过滤攻击技 + map_fight 手动路径强制改选辅助技
    "noAttackRounds": 1 },
  "10319": { "id": 10319, "name": "崩坏琴声", "effType": 1058, "type": 1,
    // 「使用后若该技能击倒敌方，则该技能使用次数增加一次（使用次数不能超过上限）」——
    // 击倒后 pp+1（封顶 cfg.pp）
    "ppRefundOnKill": true },
  // —— 2026-11-09 P0 辅助技批次（未实现清单前 8 个；效果口径见各条注释）——
  "10186": { "id": 10186, "name": "飞升灵药", "effType": 2002, "type": 3,
    // 「使目标进入飞升状态，飞升中的誓灵必定被暴击，提升能力等级时额外提升1级」
    // 3 回合；被攻击必暴（settleSkill 暴击段 isForceCrit）；gainStat 正向提升额外 +1
    "ascend": { "rounds": 3 } },
  "10245": { "id": 10245, "name": "圣光救赎", "effType": 2002, "type": 3,
    // 「回复目标25%HP，同时消除所有负面能力等级，每消除一级，增加5%回复量」
    "holyRedemption": { "healPct": 25, "perClearPct": 5 } },
  "10312": { "id": 10312, "name": "光坂的护佑", "effType": 2011, "type": 3,
    // 「为己方全体添加10%护盾；若为clannad阵营誓灵，护盾量变为15%」
    "teamShieldPct": 10, "teamShieldPctClannad": 15 },
  "10314": { "id": 10314, "name": "熊之外套", "effType": 2002, "type": 3,
    // 「为目标添加自身等级*6的护盾值；如果对象为clannad阵营誓灵，则系数变为8」
    "targetShieldLevelMul": { "base": 6, "clannad": 8 } },
  "10353": { "id": 10353, "name": "纯洁之心", "effType": 2002, "type": 3,
    // 「3回合内免疫异常状态且每回合结束时随机提升1级能力等级」
    "pureHeart": { "rounds": 3 } },
  "10375": { "id": 10375, "name": "圣甲虫护壳", "effType": 2011, "type": 3,
    // 「消耗自身30%最大生命 使己方3回合内受到伤害降低25%，且免疫异常状态一次，
    //   若已有减伤效果则提升随机防御和攻击1级」
    "scarabShell": { "hpCostPct": 30, "rounds": 3, "dmgDownPct": 25, "abnormalImmuneCharges": 1, "bonusIfMit": true } },
  "10391": { "id": 10391, "name": "奉献誓约", "effType": 2001, "type": 3,
    // 「失去当前30%生命，防御等级提升1级，吸引3次单体攻击，次数消耗完时己方全体较高攻击提升1级」
    "devotionPact": { "hpCostPct": 30, "defUp": 1, "tauntHits": 3 } },
  "10426": { "id": 10426, "name": "灵归", "effType": 2002, "type": 3,
    // 「回复目标25%生命值，己方其他誓灵获得一半的回复效果」
    "lifeReturn": { "healPct": 25, "othersPct": 12.5 } },
  // —— 2026-11-10 P1 辅助技批次（13 个）——
  "10253": { "id": 10253, "name": "王座的守护", "effType": 2002, "type": 3,
    // 「本回合受到伤害减少25%，每受到一次攻击，较高一项攻击提升1级」
    "kingsGuard": { "dmgDownPct": 25, "rounds": 1 } },
  "10263": { "id": 10263, "name": "血坏", "effType": 2001, "type": 3,
    // 「物攻提升至最大；血坏状态回合末损失最大HP×回合数×10%（最大30%，至少1HP）」
    "bloodRuin": { "rounds": 3, "perTurnPct": 10, "maxPct": 30 } },
  "10270": { "id": 10270, "name": "虚伪创生", "effType": 2001, "type": 3,
    "statChanges": [
      { "target": "self", "prop": 102, "delta": 1 },
      { "target": "self", "prop": 103, "delta": 1 },
      { "target": "self", "prop": 104, "delta": 1 }
    ] },
  "10285": { "id": 10285, "name": "ORa！", "effType": 2001, "type": 3,
    // 「本回合获得仇恨吸引效果，随机提升1项防御等级1级」
    "selfTaunt": { "rounds": 1 }, "randomDefUp": 1 },
  "10289": { "id": 10289, "name": "光之妖刃", "effType": 2002, "type": 3,
    // 「将自身所有能力等级同步给队友」（替换目标能力等级）
    "statLevelCopy": true },
  "10305": { "id": 10305, "name": "善根萌长", "effType": 2002, "type": 3,
    // 「使友方负面能力等级转为相应的正向能力等级」
    "invertNegativeTarget": true },
  "10320": { "id": 10320, "name": "注意集中", "effType": 2002, "type": 3,
    // 「目标三回合内能力等级不会降低且不会进入异常状态」
    "statDownImmunityRounds": 3, "noAbnormalRounds": 3 },
  "10321": { "id": 10321, "name": "后见之明", "effType": 2002, "type": 3,
    // 「优先度-1；若本回合该誓灵受到过攻击，则物攻、魔攻和速度+2」
    "foresight": { "atkUp": 2 } },
  "10323": { "id": 10323, "name": "永恒解脱", "effType": 2001, "type": 3,
    // 「开启后自身伤害+300%，4回合后进入解脱状态：只能使用辅助技能，被魔攻技能攻击必定被击倒」
    "eternalRelease": { "rounds": 4, "dmgMul": 4 } },
  "10399": { "id": 10399, "name": "瑶草", "effType": 2002, "type": 3,
    // 「本回合内受到的直接技能伤害会反馈至攻击者」
    "reflectDirect": { "rounds": 1 } },
  "10414": { "id": 10414, "name": "无上宽恕", "effType": 2001, "type": 3,
    // 「清除自身所有能力等级；5回合内造成伤害和暴击率提升 n×10%（n=消除级数）」
    "forgive": { "rounds": 5, "perClearPct": 10 } },
  "10431": { "id": 10431, "name": "玄佑", "effType": 2001, "type": 3,
    // 「对自身造成60威力（按自身物攻计算）伤害，触发3次天赋；物防魔防各+1」
    "xuanYou": { "power": 60, "defUp": 1, "talentHits": 3 } },
  "10432": { "id": 10432, "name": "羁绊连环", "effType": 2002, "type": 3,
    // 「目标为青龙/朱雀/玄武时，立即释放其最后释放的技能（单体目标随机）；成功后自身跳过下次行动」
    "bondChain": true },
  // —— 2026-11-13 P1.5 群体辅助批次（6 个）——
  "10216": { "id": 10216, "name": "星之传承", "effType": 2011, "type": 3,
    // 「使用者HP≥40%：2回合内己方伤害+30%；HP<40%：+60%」
    "starLegacy": { "rounds": 2, "threshold": 40, "highPct": 30, "lowPct": 60 } },
  "10283": { "id": 10283, "name": "自由的呼吸", "effType": 2011, "type": 3,
    // 「损失自身15%最大生命；己方全体随机能力+1~2级；HOLOLIVE 额外+1」
    "freeBreath": { "hpCostPct": 15, "minUp": 1, "maxUp": 2, "holoExtra": 1 } },
  "10291": { "id": 10291, "name": "风之返恩", "effType": 2011, "type": 3,
    // 「己方全体下一次攻击伤害+30%；若5回合内该誓灵对使用者用过辅助技，则为+60%」
    "windGrace": { "basePct": 30, "boostedPct": 60, "window": 5 } },
  "10310": { "id": 10310, "name": "宝幡", "effType": 2011, "type": 3,
    // 「清除我方所有负面能力等级，且随机一项防御+1」
    "treasureBanner": true },
  "10358": { "id": 10358, "name": "守护灵", "effType": 2011, "type": 3,
    // 「己方本回合受伤-35%，受到治疗+20%」
    "guardianSpirit": { "dmgDownPct": 35, "healUpPct": 20, "rounds": 1 } },
  "10365": { "id": 10365, "name": "生命绽放", "effType": 2011, "type": 3,
    // 「己方全体+10%护盾；消耗场上所有生命之种，随机 n 项能力+1」
    "lifeBloom": { "shieldPct": 10 } }
}

function getSkillRule(skillId) {
  return SKILL_EFFECT_RULES[String(skillId)] || SKILL_EFFECT_RULES[skillId] || null;
}

module.exports = {
  PROP_CODES,
  PROP_ATTR_NAMES,
  PROP_FEATURE_IDS,
  BUFF_IDS,
  BUFF_FEATURE_IDS,
  encodeAttrVal,
  encodeBuffVal,
  SKILL_EFFECT_RULES,
  getSkillRule,
};
