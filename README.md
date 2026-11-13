# SIF Competitor Monitor

Daily NAV, returns, volatility, beta, portfolio construction and AUM of India's hybrid long-short SIFs.

- Site: rebuilt and published by GitHub Actions after every trading day (00:15 IST, Tue-Sat), and on any push to `main`.
- Run locally: `pip install -r requirements.txt`, then `python3 monitor/run.py && python3 monitor/build_site.py`; open `monitor/site/index.html` through a local server (`python3 -m http.server -d monitor/site`).
- Sources and method: `monitor/README.md`.
