import json, urllib.request
def q(sql):
    req = urllib.request.Request("http://127.0.0.1:8080/",
        data=json.dumps({"statements":[sql]}).encode(),
        headers={"Content-Type":"application/json"})
    return urllib.request.urlopen(req, timeout=20).read().decode()
print("TABLES:", q("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%status%' OR name LIKE '%incident%' OR name LIKE '%check%' OR name LIKE '%monitor%')"))
print("MONITOR_STATUS:", q("SELECT * FROM monitor_status LIMIT 5"))
