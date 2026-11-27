using System;
using UnityEngine;

namespace Assets.Script.Com.Sdk.Android
{
	public class SDKInterfaceAndroid : SDKInterface
	{
		private bool _loggedIn;

		private static void EmitCallback(string type, int code, string dataJson)
		{
			if (SDKCallback.Instance == null)
			{
				SDKCallback.InitCallback();
			}
			if (SDKCallback.Instance != null)
			{
				string payload = "{\"type\":\"" + type + "\",\"code\":" + code + ",\"data\":\"" + (dataJson ?? "{}").Replace("\"", "\\\"") + "\"}";
				SDKCallback.Instance.OnSdkCallback(payload);
			}
		}

		public override void DoAction(string callType, string jsonStr = null)
		{
			if (callType == "ACT_LOGIN")
			{
				_loggedIn = true;
				EmitCallback("ACT_LOGIN", 1, "{}");
			}
			else if (callType == "ACT_LOGOUT")
			{
				_loggedIn = false;
				EmitCallback("ACT_LOGOUT", 1, "{}");
			}
			else if (callType == "ACT_EXIT")
			{
				// code=0 lets Lua show the in-game "确定退出游戏？" dialog
				EmitCallback("ACT_EXIT", 0, "{}");
			}
			else if (callType == "ACT_OPEN_AGREEMENT")
			{
				EmitCallback("ACT_OPEN_AGREEMENT", 1, "{}");
			}
		}

		public override int GetInt(string callType, string jsonStr = null)
		{
			return 0;
		}

		public override bool GetBool(string callType, string jsonStr = null)
		{
			if (callType == "GET_IS_3TH_PF") return true;
			if (callType == "GET_IS_CPUx64") return true;
			if (callType == "GET_IS_LOGIN") return _loggedIn;
			if (callType == "GET_HAS_PERMISSION") return true;
			return false;
		}

		public override string GetString(string callType, string jsonStr = null)
		{
			if (callType == "GET_USER_ID" || callType == "GET_USER_NAME")
			{
				string acc = Assets.Plugins.Scripts.Util.SystemConfig.Account;
				return string.IsNullOrEmpty(acc) ? "player" : acc;
			}
			if (callType == "GET_SESSION_ID") return "local_session";
			if (callType == "GET_CHANNEL_ID") return string.Empty;
			return string.Empty;
		}
	}
}
