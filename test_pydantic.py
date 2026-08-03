from shared.schemas import Zone
import json

z = Zone(name='test', polygon=[{'x': 10, 'y': 20}])
try:
    pts = [p.dict() if hasattr(p, 'dict') else p.model_dump() for p in z.polygon]
    print("SUCCESS:", json.dumps(pts))
except Exception as e:
    import traceback
    traceback.print_exc()
    print("ERROR:", e)
