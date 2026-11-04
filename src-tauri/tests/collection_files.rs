//! Writing and reading a collection folder: prune removes only Dispatch files, and paths can't escape the folder.
use dispatch_lib::{collection_dir_read as read_collection_dir, collection_dir_write as write_collection_dir};

#[test]
fn writes_prunes_and_refuses_escapes() {
    let root = std::env::temp_dir().join(format!("dispatch-files-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let r = root.display().to_string();
    let f = |p: &str, t: &str| (p.to_string(), t.to_string());
    write_collection_dir(r.clone(), vec![f("dispatch.collection.yaml", "name: A\n"), f("orders/_folder.yaml", "name: Orders\n"), f("orders/list.req.yaml", "name: List\n"), f("login.req.yaml", "name: Login\n")], true).unwrap();
    std::fs::write(root.join("README.md"), "mine").unwrap();
    let mut got: Vec<String> = read_collection_dir(r.clone()).unwrap().into_iter().map(|(p, _)| p).collect();
    got.sort();
    assert_eq!(got, ["dispatch.collection.yaml", "login.req.yaml", "orders/_folder.yaml", "orders/list.req.yaml"]);
    // Folder removed and request renamed: stale files go, empty folders go, other files stay.
    write_collection_dir(r.clone(), vec![f("dispatch.collection.yaml", "name: A\n"), f("sign-in.req.yaml", "name: Login\n")], true).unwrap();
    let mut got: Vec<String> = read_collection_dir(r.clone()).unwrap().into_iter().map(|(p, _)| p).collect();
    got.sort();
    assert_eq!(got, ["dispatch.collection.yaml", "sign-in.req.yaml"]);
    assert!(!root.join("orders").exists());
    assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "mine");
    // No escaping the folder.
    assert!(write_collection_dir(r.clone(), vec![f("../evil.req.yaml", "x")], false).is_err());
    assert!(write_collection_dir(r.clone(), vec![f("/tmp/evil.req.yaml", "x")], false).is_err());
    let _ = std::fs::remove_dir_all(&root);
}
