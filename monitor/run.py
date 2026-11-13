"""One command for the whole refresh:  python3 monitor/run.py

1. fetch_nav          AMFI SIF universe + full daily NAV history + benchmarks; Groww NAV cross-check and fill
2. fetch_portfolios   new official portfolio files where the AMC publishes plain links (Arudha);
                      Groww snapshot of every hybrid fund's latest portfolio and AUM
3. analytics          returns, volatility, beta, alpha, drawdown, capture
4. holdings           construction, cap split, concentration, trades
5. build              dashboard files in data/monitor/dash/
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import analytics  # noqa: E402
import build  # noqa: E402
import fetch_nav  # noqa: E402
import fetch_portfolios  # noqa: E402
import holdings  # noqa: E402

if __name__ == "__main__":
    print("1/5 NAVs");          fetch_nav.main()
    print("2/5 portfolios");    print("   new AMC files:", fetch_portfolios.arudha() or "none")
    print("   new Groww snapshots:", fetch_portfolios.groww(holdings.FUNDS) or "none")
    print("3/5 analytics");     analytics.main()
    print("4/5 holdings");      holdings.main()
    print("5/5 build");         build.main()
