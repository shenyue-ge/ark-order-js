module("MainModule", package.seeall)
require("Modules.Main.View.MainActItem")
require("Modules.Main.View.MainActPermitBuyPanel")
require("Modules.Main.View.MainActPermitPanel")
require("Modules.Main.View.MainActPermitRewardItem")
require("Modules.Main.View.MainAppIcon")
require("Modules.Main.View.MainAppPage")
require("Modules.Main.View.MainAppPanel")
require("Modules.Main.View.MainBg0")
require("Modules.Main.View.MainBg1")
require("Modules.Main.View.MainBg2")
require("Modules.Main.View.MainBg3")
require("Modules.Main.View.MainBg4")
require("Modules.Main.View.MainBg5")
require("Modules.Main.View.MainBg6")
require("Modules.Main.View.MainBg7")
require("Modules.Main.View.MainBg8")
require("Modules.Main.View.MainBg9")
require("Modules.Main.View.MainBgPanel")
require("Modules.Main.View.MainBgPanelTry")
require("Modules.Main.View.MainBubbleItem")
require("Modules.Main.View.MainBubblePanel")
require("Modules.Main.View.MainDispatcherApp")
require("Modules.Main.View.MainDispatcherAppItem")
require("Modules.Main.View.MainDispatcherItem")
require("Modules.Main.View.MainDispatcherPanel")
require("Modules.Main.View.MainDormAppIcon")
require("Modules.Main.View.MainFunctionPanel")
require("Modules.Main.View.MainHorizontalButtonItem")
require("Modules.Main.View.MainItemAppIcon")
require("Modules.Main.View.MainLittleActItem")
require("Modules.Main.View.MainLoadingPanel")
require("Modules.Main.View.MainPanel")
require("Modules.Main.View.MainPermitBuyLevelPanel")
require("Modules.Main.View.MainPlayerBackIndexView")
require("Modules.Main.View.MainPlayerBackMissionView")
require("Modules.Main.View.MainPlayerBackPanel")
require("Modules.Main.View.MainPlayerBackPermitView")
require("Modules.Main.View.MainPlayerBackRechargeView")
require("Modules.Main.View.MainPlayerGrowIndexView")
require("Modules.Main.View.MainPlayerGrowMissionView")
require("Modules.Main.View.MainPlayerGrowPanel")
require("Modules.Main.View.MainPurdahPanel")
require("Modules.Main.View.MainRedBagPanel")
require("Modules.Main.View.MainSceneThemeItem")
require("Modules.Main.View.MainSceneThemePanel")
require("Modules.Main.View.MainThemePreviewPanel")
require("Modules.Main.View.MainTowerAutoButton")
require("Modules.Main.View.MainVerticalButtonItem")
createModulePanelFunc("MainModule", "actPermitBuyPanel", MainActPermitBuyPanel)
createModulePanelFunc("MainModule", "actPermitPanel", MainActPermitPanel)
createModulePanelFunc("MainModule", "appPanel", MainAppPanel)
createModulePanelFunc("MainModule", "bgPanel", MainBgPanel)
createModulePanelFunc("MainModule", "bgPanelTry", MainBgPanelTry)
createModulePanelFunc("MainModule", "bubblePanel", MainBubblePanel)
createModulePanelFunc("MainModule", "dispatcherPanel", MainDispatcherPanel)
createModulePanelFunc("MainModule", "functionPanel", MainFunctionPanel)
createModulePanelFunc("MainModule", "loadingPanel", MainLoadingPanel)
createModulePanelFunc("MainModule", "panel", MainPanel)
createModulePanelFunc("MainModule", "permitBuyLevelPanel", MainPermitBuyLevelPanel)
createModulePanelFunc("MainModule", "playerBackPanel", MainPlayerBackPanel)
createModulePanelFunc("MainModule", "playerGrowPanel", MainPlayerGrowPanel)
createModulePanelFunc("MainModule", "purdahPanel", MainPurdahPanel)
createModulePanelFunc("MainModule", "redBagPanel", MainRedBagPanel)
createModulePanelFunc("MainModule", "sceneThemePanel", MainSceneThemePanel)
createModulePanelFunc("MainModule", "themePreviewPanel", MainThemePreviewPanel)

-- 本地服修改：看板娘切换持久化。主页切换按钮（spChangeHelp → onChangeHelp(true, false)）
-- 是纯本地行为（MainMgr.helpIndex 循环），服务器无从得知当前显示的看板娘，
-- 重进游戏只会显示 help_list 首位。这里包装 onChangeHelp：按钮切换且 helpId 实际变化时，
-- 借聊天通道发 GM 指令 m21_set_helper=<誓灵id> 通知服务器记录（服务器回 info_toc 解除网络等待）。
-- 随机切换（UI 返回，slot2=true）与面板刷新（slot1=false）不通知，保持官方随机行为
print("PS-MAIN-AUTOGEN-LOADED type(MainFunctionPanel.onChangeHelp)=" .. type(MainFunctionPanel.onChangeHelp))

local _psOrigOnChangeHelp = MainFunctionPanel.onChangeHelp

function MainFunctionPanel.onChangeHelp(slot0, slot1, slot2)
	-- 登录首显（slot1==nil，面板初始化无参调用）：主页实际显示 MainMgr.helpId = getGroupList()[helpIndex]（誓灵仓库）。
	-- 这里优先定位到服务端下发的看板娘 RoleMgr.helper（info_toc.helper = 最后切换的那只），实现持久化。
	if slot1 == nil and RoleMgr.helper and RoleMgr.helper > 0 then
		local _psGl = RoleMgr.getGroupList()
		for _i = 1, #_psGl do
			if _psGl[_i] == RoleMgr.helper then
				MainMgr.helpIndex = _i
				break
			end
		end
		print("PS-FIRSTSHOW helper=" .. tostring(RoleMgr.helper) .. " -> helpIndex=" .. tostring(MainMgr.helpIndex))
	end

	-- 关键修复：窗口返回（slot2 == true 时为官方的 UI 返回随机换看板娘行为）
	-- 随机换看板娘会导致主线程反复重新加载大纹理与 Live2D 导致明显卡顿，且让用户设置的看板娘被频繁篡改。
	-- 此处直接拦截，保持当前看板娘不变！
	if slot2 == true then
		return
	end

	local _psPrev = MainMgr.helpId
	_psOrigOnChangeHelp(slot0, slot1, slot2)
	print("PS-ONCHANGE slot1=" .. tostring(slot1) .. " slot2=" .. tostring(slot2) .. " helpId=" .. tostring(MainMgr.helpId) .. " prev=" .. tostring(_psPrev))

	if slot1 and slot2 == false and MainMgr.helpId ~= nil and MainMgr.helpId ~= _psPrev and MainMgr.helpId > 1 then
		local ok, err = pcall(function()
			Net.createAndSendProto("m_chat_in_channel_tos", {
				channel = 1,
				msg = "m21_set_helper=" .. MainMgr.helpId,
				msg_type = 0
			})
		end)
		if not ok then
			print("PS-ONCHANGE send FAILED: " .. tostring(err))
		else
			print("PS-ONCHANGE sent m21_set_helper=" .. tostring(MainMgr.helpId))
		end
	end
end

-- ─────────────────────────────────────────────────────────────────────────────
-- 本地服修改：立绘触摸涨羁绊（触摸好感）——只给"大厅主页面立绘点击"打 play_type=3
--
-- 背景：触摸没有专用协议，客户端只借图鉴语音上报
--   m_role_handbook_play_cv_tos{servant_type_id, cv_id, play_type}
-- 而 play_type=2 同时来自图鉴点播 / 详情页立绘 / 养成自动上报等 12 个调用方，
-- 服务端无法区分"大厅里真的摸了角色"。
--
-- 做法：不改 MainFunctionPanel 的原函数体，只包两层——
--   · onCardClick：置实例标记 __psTouchFromCard，跑完原函数后清掉（异常也清）；
--   · playCv：只有该标记在、且没有被 timeOutKey 提前拦下时，才在原调用
--     （仍是 play_type=2，保持图鉴"听过"逻辑原样）之后**追加一条** play_type=3。
--   ⇒ 其余调用方（onActPredeal 登录语音 / updateCardView 待机语音 / 详情页 / 养成 / 战斗）
--     一个字节都不变，只有大厅立绘触摸会多发这条标记包。
--
-- 兼容性：服务端未实现触摸时只把 play_type=3 当普通 play_cv 吃掉（回 m_common_reply_toc），
--   不会报错、不会断线；反过来，未打本补丁的客户端大厅触摸仍发 2 ⇒ 服务端不计数（功能不生效）。
-- 安装时机：本文件已 require MainFunctionPanel；createModulePanelFunc 只登记工厂，
--   面板实例化与 initHandler 绑定 onCardClick 都更晚，因此替换对实例生效。
-- ─────────────────────────────────────────────────────────────────────────────
do
	if type(MainFunctionPanel) == "table"
		and type(MainFunctionPanel.onCardClick) == "function"
		and type(MainFunctionPanel.playCv) == "function" then
		local _psRawOnCardClick = MainFunctionPanel.onCardClick
		local _psRawPlayCv = MainFunctionPanel.playCv

		MainFunctionPanel.onCardClick = function(self, eventData)
			self.__psTouchFromCard = true
			local ok, err = pcall(_psRawOnCardClick, self, eventData)
			self.__psTouchFromCard = false
			if not ok then
				error(err)
			end
		end

		MainFunctionPanel.playCv = function(self, typeId, cvId)
			-- 与原函数同一个提前返回口径：上一句台词还没消失时不会播新语音，也就不算一次触摸
			local touch = self.__psTouchFromCard and not self.timeOutKey
			local r1, r2 = _psRawPlayCv(self, typeId, cvId)
			if touch and typeId and cvId and type(Net) == "table" and type(Net.createAndSendProto) == "function" then
				-- 上报失败也不能影响 UI：触摸是"副作用"，断线/未连接时静默跳过
				pcall(Net.createAndSendProto, "m_role_handbook_play_cv_tos", {
					servant_type_id = typeId,
					cv_id = cvId,
					play_type = 3
				})
			end
			return r1, r2
		end

		print("PS-TOUCH-FEELING installed")
	else
		print("PS-TOUCH-FEELING skip: MainFunctionPanel 不可用（" .. type(MainFunctionPanel) .. "）")
	end
end

__msgList = {}
__netList = {}

-- 本地服修改（2026-09-04 三十九，替代 2026-08-23 的"关闭全部引导"补丁）：重新启用引导。
-- 背景：当时功能解锁引导（方舟组 123）运行中吞面板点击，图省事全局禁掉；现服务端已实装
-- 新手引导全链路（进度跟踪/自设名/选灵/引导二战，见 server/handlers/guide.js），必须放开。
-- 注意 DebugMode=true（lua_remote 通道依赖）会让 GuideModule 原值 openGuide = not IsDebug = false，
-- 所以这里强制置 true；tryDoGroup 不再中和。
-- 防复发口径：哪些引导组会触发由**服务端下发的未完成列表**决定（p_role_data.guide.guide_groups，
-- 见 server/data/guide_data.js）——功能开启引导（60~125）有意不进列表，等于按组精准关闭；
-- 引导行为异常时优先查服务端数据，别把开关一关了事（重蹈 08-23 覆辙）。
do
	pcall(require, "Modules.Guide.GuideModule")
	if type(GuideModule) == "table" then
		GuideModule.openGuide = true
		print("PS-GUIDE-ENABLED openGuide=" .. tostring(GuideModule.openGuide))
	else
		print("PS-GUIDE-MISS GuideModule=" .. type(GuideModule))
	end
end

-- 本地服修改（二）：指令战修复。
-- ① m_war_round_info_toc 处理器第一步就 ArkMgr.clear()，会把 curFightId 清 0——
--   而 copy_war/show_toc 之外没有任何包恢复它 → 战斗面板右上角恒显"不存在事件:0"。
--   这里让 clear 保留 curFightId/curFightEventOid（官方服务端必有等价恢复机制，形式不可考）。
-- ② GlobalData.serverTime 只在登录时由 m_role_detail_toc.server_time 设置一次，
--   心跳帧的时间戳客户端并不消费 → 科研队列倒计时 endTime-serverTime 冻结
--   （真机表现：卡在"登录后经过时长+研发时长"不动）。借客户端每秒一次的
--   NetHeartBeat.sendHB 钩子让 serverTime 本地走秒。
do
	pcall(require, "Modules.Ark.ArkMgr")
	if type(ArkMgr) == "table" and ArkMgr.clear ~= nil then
		local _psOrigClear = ArkMgr.clear
		ArkMgr.clear = function(...)
			local _cf = ArkMgr.curFightId
			local _ce = ArkMgr.curFightEventOid
			_psOrigClear(...)
			ArkMgr.curFightId = _cf
			ArkMgr.curFightEventOid = _ce
		end
		print("PS-ARK-CLEAR-WRAPPED")
	else
		print("PS-ARK-MISS ArkMgr=" .. type(ArkMgr))
	end
	pcall(require, "Core.NetHeartBeat")
	if type(NetHeartBeat) == "table" and NetHeartBeat.sendHB ~= nil then
		local _psOrigSendHB = NetHeartBeat.sendHB
		NetHeartBeat.sendHB = function(...)
			local _t = GlobalData.serverTime or 0
			local _os = os.time()
			if _t <= 0 or math.abs(_t - _os) > 86400 then
				-- 登录包缺 server_time 或与设备时钟偏差过大 → 直接校准（本地服与客户端同机，时差可忽略）
				GlobalData.serverTime = _os
				print("PS-SERVERTIME-CALIB " .. tostring(_os))
			else
				GlobalData.serverTime = _t + 1
			end
			return _psOrigSendHB(...)
		end
		print("PS-SERVERTIME-TICK-INSTALLED")
	else
		print("PS-HB-MISS NetHeartBeat=" .. type(NetHeartBeat))
	end
end

function addMessageListener(slot0, slot1, slot2)
	ModuleFactory.addMessageListener(MainModule, slot0, slot1, slot2)
end

function removeMessageListener(slot0, slot1)
	ModuleFactory.removeMessageListener(MainModule, slot0, slot1)
end

function removeAllListener()
	ModuleFactory.removeAllListener(MainModule)
end

function registerSocketHandler(slot0, slot1)
	ModuleFactory.registerSocketHandler(MainModule, slot0, slot1)
end

function removeSocketHandler(slot0, slot1)
	ModuleFactory.removeSocketHandler(MainModule, slot0, slot1)
end

function removeAllSocketHandler()
	ModuleFactory.removeAllSocketHandler(MainModule)
end

function onDispose()
	MainMgr.onDispose()
	removeAllListener()
	removeAllSocketHandler()
end
