//+------------------------------------------------------------------+
//|                                                  RabihAlerts.mq5 |
//|                              Rabih Assistant — MT5 Trade Alerts   |
//|        Sends trade open/close events to Railway backend via HTTP  |
//+------------------------------------------------------------------+
#property copyright "Rabih Assistant"
#property version   "1.00"
#property description "Sends trade alerts to Rabih Assistant backend"

// IMPORTANT: Add this URL to MT5 allowed URLs:
// Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL:
// https://rabih-assistant-production.up.railway.app

input string ServerURL = "https://rabih-assistant-production.up.railway.app/trade-alert";

// Track last known positions to detect opens/closes
int lastPositionCount = 0;
ulong lastTickets[];

//+------------------------------------------------------------------+
//| Expert initialization function                                     |
//+------------------------------------------------------------------+
int OnInit()
{
   // Snapshot current positions on startup
   lastPositionCount = PositionsTotal();
   ArrayResize(lastTickets, lastPositionCount);
   for(int i = 0; i < lastPositionCount; i++)
   {
      lastTickets[i] = PositionGetTicket(i);
   }
   Print("RabihAlerts initialized. Tracking ", lastPositionCount, " positions.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                   |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("RabihAlerts removed.");
}

//+------------------------------------------------------------------+
//| Trade event handler                                                |
//+------------------------------------------------------------------+
void OnTrade()
{
   CheckForNewPositions();
   CheckForClosedPositions();
   UpdatePositionSnapshot();
}

//+------------------------------------------------------------------+
//| Check for newly opened positions                                   |
//+------------------------------------------------------------------+
void CheckForNewPositions()
{
   int currentCount = PositionsTotal();
   for(int i = 0; i < currentCount; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      // Check if this ticket existed before
      bool isNew = true;
      for(int j = 0; j < ArraySize(lastTickets); j++)
      {
         if(lastTickets[j] == ticket)
         {
            isNew = false;
            break;
         }
      }

      if(isNew)
      {
         PositionSelectByTicket(ticket);
         string symbol = PositionGetString(POSITION_SYMBOL);
         double volume = PositionGetDouble(POSITION_VOLUME);
         double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         double sl = PositionGetDouble(POSITION_SL);
         double tp = PositionGetDouble(POSITION_TP);
         long posType = PositionGetInteger(POSITION_TYPE);
         string direction = (posType == POSITION_TYPE_BUY) ? "buy" : "sell";

         string json = "{";
         json += "\"type\":\"open\",";
         json += "\"pair\":\"" + symbol + "\",";
         json += "\"direction\":\"" + direction + "\",";
         json += "\"lot\":" + DoubleToString(volume, 2) + ",";
         json += "\"entry\":" + DoubleToString(openPrice, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + ",";
         json += "\"sl\":" + DoubleToString(sl, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + ",";
         json += "\"tp\":" + DoubleToString(tp, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + ",";
         json += "\"platform\":\"MT5\"";
         json += "}";

         SendAlert(json);
         Print("Trade OPEN alert sent: ", symbol, " ", direction, " ", volume);
      }
   }
}

//+------------------------------------------------------------------+
//| Check for closed positions                                         |
//+------------------------------------------------------------------+
void CheckForClosedPositions()
{
   for(int i = 0; i < ArraySize(lastTickets); i++)
   {
      ulong ticket = lastTickets[i];
      if(ticket == 0) continue;

      // Check if this ticket still exists
      bool stillOpen = false;
      for(int j = 0; j < PositionsTotal(); j++)
      {
         if(PositionGetTicket(j) == ticket)
         {
            stillOpen = true;
            break;
         }
      }

      if(!stillOpen)
      {
         // Position was closed — get details from deal history
         SendCloseAlert(ticket);
      }
   }
}

//+------------------------------------------------------------------+
//| Send close alert by looking up deal history                        |
//+------------------------------------------------------------------+
void SendCloseAlert(ulong positionTicket)
{
   // Select deals from the last 24 hours to find the closing deal
   datetime from = TimeCurrent() - 86400;
   datetime to = TimeCurrent() + 60;
   HistorySelect(from, to);

   string symbol = "";
   string direction = "";
   double volume = 0;
   double profit = 0;
   bool found = false;

   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;

      if(HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID) == (long)positionTicket)
      {
         long dealEntry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
         if(dealEntry == DEAL_ENTRY_OUT || dealEntry == DEAL_ENTRY_OUT_BY)
         {
            symbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
            volume = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
            profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
                   + HistoryDealGetDouble(dealTicket, DEAL_SWAP)
                   + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
            long dealType = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
            // Close deal type is opposite of position direction
            direction = (dealType == DEAL_TYPE_SELL) ? "buy" : "sell";
            found = true;
            break;
         }
      }
   }

   if(!found)
   {
      // Fallback: just send what we know
      symbol = "UNKNOWN";
      profit = 0;
   }

   string json = "{";
   json += "\"type\":\"close\",";
   json += "\"pair\":\"" + symbol + "\",";
   json += "\"direction\":\"" + direction + "\",";
   json += "\"lot\":" + DoubleToString(volume, 2) + ",";
   json += "\"profit\":" + DoubleToString(profit, 2) + ",";
   json += "\"platform\":\"MT5\"";
   json += "}";

   SendAlert(json);
   Print("Trade CLOSE alert sent: ", symbol, " profit=", profit);
}

//+------------------------------------------------------------------+
//| Update the position snapshot                                       |
//+------------------------------------------------------------------+
void UpdatePositionSnapshot()
{
   lastPositionCount = PositionsTotal();
   ArrayResize(lastTickets, lastPositionCount);
   for(int i = 0; i < lastPositionCount; i++)
   {
      lastTickets[i] = PositionGetTicket(i);
   }
}

//+------------------------------------------------------------------+
//| Send HTTP POST to the server                                       |
//+------------------------------------------------------------------+
void SendAlert(string jsonPayload)
{
   char postData[];
   char result[];
   string headers = "Content-Type: application/json\r\n";
   string resultHeaders;

   StringToCharArray(jsonPayload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   // Remove null terminator that StringToCharArray adds
   ArrayResize(postData, ArraySize(postData) - 1);

   int timeout = 5000;
   int res = WebRequest("POST", ServerURL, headers, timeout, postData, result, resultHeaders);

   if(res == -1)
   {
      int errorCode = GetLastError();
      Print("WebRequest failed. Error: ", errorCode,
            ". Make sure ", ServerURL, " is in Tools -> Options -> Expert Advisors -> Allow WebRequest");
   }
   else
   {
      Print("Alert sent successfully. HTTP ", res);
   }
}

//+------------------------------------------------------------------+
//| Tick function (required but not used)                               |
//+------------------------------------------------------------------+
void OnTick()
{
   // Trade events are handled by OnTrade()
}
//+------------------------------------------------------------------+
