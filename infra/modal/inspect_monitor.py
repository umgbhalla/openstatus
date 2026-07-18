import json, urllib.request
def q(sql):
    req=urllib.request.Request("http://127.0.0.1:8080/",data=json.dumps({"statements":[sql]}).encode(),headers={"Content-Type":"application/json"})
    return urllib.request.urlopen(req,timeout=20).read().decode()
print("TB_PING_COUNT:", q("SELECT count(*) c, max(latency) FROM tb_ping"))
print("SAMPLE:", q("SELECT monitor_id,region,latency,status_code,request_status FROM tb_ping LIMIT 3"))
