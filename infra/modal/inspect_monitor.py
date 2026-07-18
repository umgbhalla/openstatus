import json, urllib.request
sql = "SELECT id,name,url,periodicity,regions,active FROM monitor"
req = urllib.request.Request("http://127.0.0.1:8080/",
    data=json.dumps({"statements":[sql]}).encode(),
    headers={"Content-Type":"application/json"})
print(urllib.request.urlopen(req, timeout=20).read().decode())
