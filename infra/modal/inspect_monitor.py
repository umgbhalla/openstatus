import json, urllib.request
def q(sql):
    req=urllib.request.Request("http://127.0.0.1:8080/",data=json.dumps({"statements":[sql]}).encode(),headers={"Content-Type":"application/json"})
    return urllib.request.urlopen(req,timeout=20).read().decode()
print("MONITOR_STATUS:", q("SELECT monitor_id,region,status,updated_at FROM monitor_status"))
