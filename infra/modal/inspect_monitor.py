import json,urllib.request
def q(s):
    r=urllib.request.Request("http://127.0.0.1:8080/",data=json.dumps({"statements":[s]}).encode(),headers={"Content-Type":"application/json"})
    return urllib.request.urlopen(r,timeout=20).read().decode()
print("COUNT:",q("SELECT count(*) c, min(cron_timestamp) mn, max(cron_timestamp) mx, sum(case when status_code=200 then 1 else 0 end) ok FROM tb_ping"))
print("MON_STATUS:",q("SELECT monitor_id,region,status,updated_at FROM monitor_status"))
