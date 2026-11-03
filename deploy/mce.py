"""Tiny MCE client (stdlib only). Reads ~/expedia-mce.env."""
import json, os, re, urllib.request, urllib.error, html

def _env():
    env = {}
    for line in open(os.path.expanduser("~/expedia-mce.env")):
        m = re.match(r"(\w+)='?([^']*)'?", line.strip())
        if m: env[m.group(1)] = m.group(2)
    return env

ENV = _env()
_tok = {}

def token():
    if not _tok:
        body = {"grant_type": "client_credentials", "client_id": ENV["MCE_CLIENT_ID"], "client_secret": ENV["MCE_CLIENT_SECRET"]}
        mid = os.environ.get("MCE_ACCOUNT_ID") or ENV.get("MCE_ACCOUNT_ID")
        if mid: body["account_id"] = mid
        r = _req("POST", ENV["MCE_AUTH_BASE_URL"].rstrip("/") + "/v2/token", body, auth=False)
        _tok.update(r)
    return _tok

def _req(method, url, body=None, auth=True, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", ctype)
    if auth: req.add_header("Authorization", "Bearer " + token()["access_token"])
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url} -> {e.code}: {e.read().decode()[:800]}")
    if ctype != "application/json": return text
    return json.loads(text) if text else {}

def rest(method, path, body=None):
    return _req(method, token()["rest_instance_url"].rstrip("/") + path, body)

def soap(action, inner):
    url = token()["soap_instance_url"].rstrip("/") + "/Service.asmx"
    env = f'''<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><s:Header><a:Action s:mustUnderstand="1">{action}</a:Action><a:To s:mustUnderstand="1">{url}</a:To><fueloauth xmlns="http://exacttarget.com">{token()["access_token"]}</fueloauth></s:Header><s:Body>{inner}</s:Body></s:Envelope>'''
    return _req("POST", url, raw=env.encode(), auth=False, ctype="text/xml")

def retrieve(obj, props, filt=""):
    p = "".join(f"<Properties>{x}</Properties>" for x in props)
    xml = soap("Retrieve", f'<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><RetrieveRequest><ObjectType>{obj}</ObjectType>{p}{filt}</RetrieveRequest></RetrieveRequestMsg>')
    rows = []
    for block in re.findall(r"<Results[^>]*>(.*?)</Results>", xml, re.S):
        rows.append({k: html.unescape(re.search(rf"<{k}>(.*?)</{k}>", block, re.S).group(1)) if re.search(rf"<{k}>(.*?)</{k}>", block, re.S) else None for k in props})
    return rows, xml

def simple_filter(prop, op, value):
    return f'<Filter xsi:type="SimpleFilterPart"><Property>{prop}</Property><SimpleOperator>{op}</SimpleOperator><Value>{value}</Value></Filter>'
