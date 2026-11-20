"""Retire the exact incumbent graph only while canonical native admission is verified."""
from hashlib import sha256
from pathlib import Path
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

from provider import HEX_ID, UUID, WORKER, Refused, require

SCOPE = json.loads(Path(__file__).with_name("incumbent.json").read_text())
KINDS = ("workflows", "queues", "workers", "buckets", "databases")
NATIVE_WORKERS = {"fidy-native-storage-core", "fidy-native-storage-ingress", "fidy-native-web"}
HOSTS = {"api.fidyapp.com": "fidy-native-storage-ingress", "app.fidyapp.com": "fidy-native-web"}
BLOCKING_WRITERS = {"issued_r2_writers", "upload_admission_events"}


def digest(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def indexed(rows, field):
    result = {row[field]: row for row in rows}
    require(len(result) == len(rows), "Duplicate provider resource identity")
    return result


def old(name):
    return name.lower().startswith("fidycloudflare-") or name == "fidy-web"


def active_worker(provider, worker):
    current = provider.result(f"workers/scripts/{worker}/deployments?per_page=1")["deployments"]
    require(type(current) is list and len(current) >= 1, "Missing Worker deployment")
    latest = current[0]
    versions = latest["versions"]
    require(len(versions) == 1 and versions[0]["percentage"] == 100 and
            UUID.fullmatch(versions[0]["version_id"]) and UUID.fullmatch(latest["id"]),
            "Worker lacks one exact serving version")
    return {"deployment": latest["id"], "version": versions[0]["version_id"]}


def releases_match(provider, opening, domains, namespaces):
    open_workers = opening["workers"]
    require(set(open_workers) == NATIVE_WORKERS, "Opening proof has an unexpected serving graph")
    for worker, identity in open_workers.items():
        require(active_worker(provider, worker) == identity, "Canonical Worker version changed after opening")
        if worker != "fidy-native-web":
            version = provider.result(f"workers/scripts/{worker}/versions/{identity['version']}")
            bindings = indexed(version["resources"]["bindings"], "name")
            for binding, expected in {
                "NATIVE_STORAGE_ADMISSION": "open",
                "RELEASE_GIT_SHA": opening["revision"],
                "CONTRACT_DIGEST": opening["contractDigest"],
            }.items():
                row = bindings.get(binding)
                require(row and row["type"] == "plain_text" and row.get("text") == expected,
                        "Canonical Worker has different release or admission bindings")
    for hostname, worker in HOSTS.items():
        row = domains.get(hostname)
        require(row is not None and row["service"] == worker and row["zone_id"] == provider.zone and
                row["id"] == opening["hosts"][hostname] and row["enabled"] is True and
                row["previews_enabled"] is False, "Canonical hostname does not match opening")
    observed = {key: row["class"] for key, row in namespaces.items() if row["script"] == "fidy-native-storage-core"}
    expected_classes = {"Directory", "UserStore", "Pricing", "Maintenance", "Erasure"}
    require(set(observed.values()) == expected_classes and len(observed) == len(expected_classes),
            "Native owner inventory is incomplete")
    require(observed == opening["namespaces"], "New SQLite owner identities changed")


def worker_references(provider, worker):
    require(WORKER.fullmatch(worker), "Unexpected Worker inventory identity")
    settings = provider.result("workers/scripts/" + worker + "/settings")
    require(type(settings["bindings"]) is list and type(settings["tail_consumers"]) is list,
            "Incomplete Worker binding inventory")
    refs = {"workers": set(), "databases": set(), "queues": set(), "buckets": set(),
            "workflows": set(), "legacyNamespaces": set()}
    fields = {
        "service": ("workers", "service"), "d1": ("databases", "database_id"),
        "queue": ("queues", "queue_name"), "r2_bucket": ("buckets", "bucket_name"),
        "workflow": ("workflows", "workflow_name"), "durable_object_namespace": ("legacyNamespaces", "namespace_id"),
    }
    for binding in settings["bindings"]:
        kind = binding["type"]
        if kind in fields:
            role, name = fields[kind]
            target = binding.get(name)
            require(isinstance(target, str) and target, "Missing resource binding target")
            refs[role].add(target)
            if kind in {"workflow", "durable_object_namespace"} and binding.get("script_name"):
                refs["workers"].add(binding["script_name"])
    refs["workers"].update(item["service"] for item in settings["tail_consumers"])
    return refs


def require_isolation(workers, workflows, references):
    obsolete = {kind: set(SCOPE[kind]) for kind in (*KINDS, "legacyNamespaces")}
    obsolete["queues"] = set(SCOPE["queues"].values())
    for worker, refs in references.items():
        if worker not in workers:
            require(all(not obsolete[kind].intersection(targets) for kind, targets in refs.items()),
                    "An unrelated Worker still consumes an incumbent resource")
    for workflow, row in workflows.items():
        require((workflow in SCOPE["workflows"]) == (row["script_name"] in workers),
                "An unexpected Workflow references an incumbent Worker")


def queue_graph(provider, queues, workers, *, require_paused=True):
    observed = {}
    obsolete_names = set(SCOPE["queues"].values())
    for ident, row in queues.items():
        consumers = provider.pages(f"queues/{ident}/consumers", "consumer_id")
        owner = ident in SCOPE["queues"]
        for consumer in consumers:
            script = consumer.get("script")
            if owner:
                require(consumer.get("type") == "worker" and script in workers and
                        consumer.get("dead_letter_queue") in obsolete_names | {None, ""},
                        "An incumbent queue depends on an unrelated consumer or dead letters")
            else:
                require(script not in SCOPE["workers"] and
                        consumer.get("dead_letter_queue") not in obsolete_names,
                        "An unrelated queue still references incumbent infrastructure")
        if owner:
            require(not require_paused or row["settings"]["delivery_paused"] is True,
                    "An incumbent queue is still delivering")
            detail = provider.result(f"queues/{ident}")
            producers = detail["producers"]
            require(type(producers) is list and detail["producers_total_count"] == len(producers),
                    "Incomplete incumbent queue producer list")
            require(all(item.get("script") in workers for item in producers),
                    "An external producer still owns an incumbent queue")
            metrics = provider.result(f"queues/{ident}/metrics")
            backlog = {name: metrics[name] for name in ("backlog_count", "backlog_bytes")}
            require(all(type(number) is int and number >= 0 for number in backlog.values()),
                    "Invalid incumbent queue backlog")
            observed[ident] = {
                "backlog": backlog,
                "consumers": sorted([item["consumer_id"], item["script"], item.get("dead_letter_queue") or ""]
                                    for item in consumers),
                "producers": sorted(item["script"] for item in producers),
            }
    return observed


def provider_inventory(provider):
    requests = (
        ("workers/scripts", "id"), ("d1/database", "uuid"), ("queues", "queue_id"),
        ("workflows", "name"), ("workers/durable_objects/namespaces", "id"),
        ("workers/domains", "hostname"),
    )
    with ThreadPoolExecutor(max_workers=4) as pool:
        workers, databases, queues, workflows, namespaces, domains = pool.map(
            lambda pair: indexed(provider.pages(*pair), pair[1]), requests
        )
    buckets = indexed(provider.buckets(), "name")
    return {"workers": workers, "databases": databases, "queues": queues, "workflows": workflows,
            "legacyNamespaces": namespaces, "hosts": domains, "buckets": buckets}


def validate_scope(graph):
    workers = {name for name in graph["workers"] if old(name)}
    require(workers <= set(SCOPE["workers"]), "An unreviewed incumbent Worker is present")
    for key, row in graph["databases"].items():
        if key in SCOPE["databases"] or old(row["name"]):
            require(SCOPE["databases"].get(key) == {k: row[k] for k in ("name", "created_at")},
                    "Incumbent database identity changed")
    for key, row in graph["buckets"].items():
        if old(key):
            require(SCOPE["buckets"].get(key) == row["creation_date"], "Incumbent bucket identity changed")
    for key, row in graph["queues"].items():
        if key in SCOPE["queues"] or old(row["queue_name"]):
            require(SCOPE["queues"].get(key) == row["queue_name"], "Incumbent queue identity changed")
    for key, row in graph["workflows"].items():
        if old(key) or row["script_name"] in SCOPE["workers"]:
            require(SCOPE["workflows"].get(key) == {"id": row["id"], "script": row["script_name"]},
                    "Incumbent Workflow identity changed")
    for key, row in graph["legacyNamespaces"].items():
        if key in SCOPE["legacyNamespaces"] or row["script"] in SCOPE["workers"]:
            require(SCOPE["legacyNamespaces"].get(key) == row["script"], "Incumbent namespace identity changed")
    return workers


def verify_exposure(provider, workers, graph):
    domains = graph["hosts"]
    require(all(row["service"] not in SCOPE["workers"] for row in domains.values()),
            "An incumbent custom hostname remains attached")
    routes = provider.pages("workers/routes", "id", zone=True)
    require(all(row.get("script") not in SCOPE["workers"] for row in routes),
            "A zone route still exposes an incumbent Worker")
    for worker in sorted(workers):
        tag = graph["workers"][worker].get("tag")
        require(isinstance(tag, str) and (UUID.fullmatch(tag) or HEX_ID.fullmatch(tag)),
                "Cannot identify incumbent Worker Build triggers")
        triggers = provider.result("builds/workers/" + tag + "/triggers", builds=True)
        require(type(triggers) is list and not triggers, "An incumbent Worker Build trigger remains enabled")


def incumbent_fence(provider):
    env = {**os.environ, "INCUMBENT_RETIREMENT_ZONE": provider.zone}
    run = subprocess.run(["bun", "infra/cloudflare/native-retirement-fence.ts"], env=env, text=True,
                         stdout=subprocess.PIPE, check=True, timeout=180)
    return json.loads(run.stdout)


def inventory(provider, opening, *, fence=incumbent_fence, continuing=False):
    graph = provider_inventory(provider)
    workers = validate_scope(graph)
    releases_match(provider, opening, graph["hosts"], graph["legacyNamespaces"])
    verify_exposure(provider, workers, graph)
    writer_fence = fence(provider)
    require(set(writer_fence["scripts"]) == workers and
            {row["id"] for row in writer_fence["pausedQueues"]} == (set(graph["queues"]) & set(SCOPE["queues"])) and
            set(writer_fence["quiescentWorkflows"]) == (set(graph["workflows"]) & set(SCOPE["workflows"])),
            "Incumbent resource and writer inventories disagree")
    with ThreadPoolExecutor(max_workers=3) as pool:
        names = sorted(graph["workers"])
        references = dict(zip(names, pool.map(lambda worker: worker_references(provider, worker), names), strict=True))
    require_isolation(workers, graph["workflows"], references)
    queues = queue_graph(provider, graph["queues"], workers)
    for kind in ("databases", "buckets"):
        owned = set(graph[kind]) & set(SCOPE[kind])
        require(all(any(key in references[worker][kind] for worker in workers) for key in owned) or continuing,
                "Incumbent data no longer has its expected ownership bindings")
    disposition = {kind: sorted(set(graph[kind]) & set(SCOPE[kind])) for kind in KINDS}
    snapshots = {worker: active_worker(provider, worker) for worker in sorted(workers)}
    worker_dependencies = {worker: sorted(references[worker]["workers"] & workers) for worker in workers}
    worker_deletion_order(worker_dependencies)
    census = {key: provider.census(key) for key in disposition["databases"]}
    objects = {}
    for key in graph["buckets"]:
        notify = provider.notification_targets(key)
        if key not in SCOPE["buckets"]:
            require(not notify.intersection(SCOPE["queues"]), "An unrelated bucket produces to an incumbent queue")
            continue
        require(not notify, "An incumbent bucket still emits object notifications")
        rows = provider.objects(key)
        objects[key] = {"count": len(rows), "fingerprints": sorted(digest(row) for row in rows),
                        "multipartClear": provider.multipart_clear(key)}
    preserve = {kind: sorted(set(graph[kind]) - set(SCOPE[kind])) for kind in (*KINDS, "legacyNamespaces")}
    return {"opening": digest(opening), "targets": disposition, "workers": snapshots,
            "queues": queues, "census": census, "objects": objects, "preserve": preserve,
            "workerDependencies": worker_dependencies,
            "legacyNamespaces": sorted(set(graph["legacyNamespaces"]) & set(SCOPE["legacyNamespaces"]))}


def worker_deletion_order(dependencies):
    pending = set(dependencies)
    order = []
    while pending:
        referenced = set().union(*(set(dependencies[worker]) for worker in pending))
        removable = sorted(pending - referenced)
        require(removable, "Incumbent Worker references form an unresolved cycle")
        order.extend(removable)
        pending.difference_update(removable)
    return order


def hold_reasons(snapshot):
    holds = []
    for database, rows in snapshot["census"].items():
        for row in rows:
            if row["attention_rows"] and row["source"] in BLOCKING_WRITERS:
                holds.append({"database": database, "source": row["source"], "count": row["attention_rows"]})
    for bucket, observed in snapshot["objects"].items():
        if observed["count"] and observed["multipartClear"] is not True:
            holds.append({"bucket": bucket, "source": "multipart-unverified"})
    return holds


def unchanged_remaining(approved, observed):
    require(approved["opening"] == observed["opening"] and approved["preserve"] == observed["preserve"],
            "Canonical or unrelated inventory changed since the protected plan")
    for kind in KINDS:
        require(set(observed["targets"][kind]) <= set(approved["targets"][kind]),
                "An unexpected target appeared after the protected plan")
    for family in ("workers", "census"):
        require(all(approved[family].get(key) == row for key, row in observed[family].items()),
                "An exact retirement identity or retained data census changed")
    for bucket, state in observed["objects"].items():
        original = approved["objects"][bucket]
        require(set(state["fingerprints"]) <= set(original["fingerprints"]),
                "An incumbent R2 object changed or appeared after inventory")
    for worker, targets in observed["workerDependencies"].items():
        require(set(targets) <= set(approved["workerDependencies"][worker]),
                "An incumbent Worker gained an unreviewed dependency")
    for queue, refs in observed["queues"].items():
        original = approved["queues"][queue]
        require(all(entry in original["consumers"] for entry in refs["consumers"]) and
                all(entry in original["producers"] for entry in refs["producers"]),
                "An incumbent queue gained an unreviewed consumer or producer")
        require(all(value <= original["backlog"][metric] for metric, value in refs["backlog"].items()),
                "An incumbent queue backlog grew after the writer fence")


def require_deleted(provider, opening, approved, kind, key):
    from time import sleep
    for attempt in range(8):
        graph = provider_inventory(provider)
        validate_scope(graph)
        releases_match(provider, opening, graph["hosts"], graph["legacyNamespaces"])
        require(all(set(approved["preserve"][family]) <= set(graph[family])
                    for family in (*KINDS, "legacyNamespaces")),
                "An unrelated provider resource disappeared")
        if key not in graph[kind]:
            if kind != "workers" or not any(r["script"] == key for r in graph["legacyNamespaces"].values()):
                return
        if attempt < 7:
            sleep(2)
    raise Refused("Provider did not confirm removal of the exact target")


def dispose(provider, opening, approved, record, *, observe=inventory, deleted=require_deleted):
    observed = observe(provider, opening, continuing=True)
    unchanged_remaining(approved, observed)
    holds = hold_reasons(observed)
    if holds:
        record({"status": "held", "holds": holds})
        raise Refused("Incumbent custody or outstanding provider work is unresolved")
    provider.verify_public_health(opening)
    for kind in KINDS:
        ordered = (worker_deletion_order(observed["workerDependencies"]) if kind == "workers"
                   else observed["targets"][kind])
        for key in ordered:
            require(key in SCOPE[kind], "Unreviewed resource in protected retirement plan")
            current = provider_inventory(provider)
            validate_scope(current)
            releases_match(provider, opening, current["hosts"], current["legacyNamespaces"])
            if kind == "workers":
                require(active_worker(provider, key) == observed["workers"][key],
                        "Incumbent Worker changed before removal")
            if kind == "buckets":
                before = provider.objects(key)
                require(sorted(digest(row) for row in before) == observed["objects"][key]["fingerprints"] and
                        (not before or provider.multipart_clear(key)) and not provider.notification_targets(key),
                        "Incumbent R2 contents or writers changed before disposal")
                if before:
                    record({"status": "object-disposal-offered", "kind": kind, "id": key, "count": len(before)})
                    for row in before:
                        provider.delete_object(key, row[0])
                    require(not provider.objects(key), "Incumbent bucket contents reappeared")
                    record({"status": "object-disposal-verified", "kind": kind, "id": key, "count": len(before)})
            if kind == "databases":
                require(provider.census(key) == observed["census"][key], "Legacy D1 census changed before disposal")
            record({"status": "offered", "kind": kind, "id": key})
            provider.delete(kind, key)
            deleted(provider, opening, approved, kind, key)
            record({"status": "absent", "kind": kind, "id": key})
    final = observe(provider, opening, continuing=True)
    require(all(not rows for rows in final["targets"].values()) and not final["legacyNamespaces"],
            "Incomplete incumbent retirement")
    require(final["preserve"] == approved["preserve"], "Unrelated resource census changed")
    provider.verify_public_health(opening)
    record({"status": "verified", "preserve": final["preserve"], "opening": final["opening"]})

