import asyncio, sys
sys.path.insert(0, "/home/skeep/tn-mqtt")
from tn_ws import connect, logs
async def main():
    tn = await connect()
    app = (await tn.call("app.query", [["name", "=", "aura"]], {"select": ["state", "active_workloads"]}))[0]
    for c in app["active_workloads"]["container_details"]:
        print("==", c["service_name"], c["state"], c["image"])
        for l in await logs("aura", c["id"], tail=int(sys.argv[1]) if len(sys.argv) > 1 else 30, seconds=4): print(l[:300])
asyncio.run(main())
