1. MCP support
   → Done (both): an MCP request type to test MCP servers (HTTP, or a local command on desktop), and `dispatch-run mcp <collection>` so AI assistants can list, send and run your requests (`claude mcp add dispatch -- dispatch-run mcp ./my-collection -e Prod`). Both checked against the official MCP SDK.
2. Duplicate environment
   → Done: "Duplicate" in the environment editor and the environment's ⋯ menu (values included).
3. Smart conversion of http request into paramertized that use environments and variables
   → Done: "Parameterize" by the request name (also offered after pasting curl) suggests {{baseUrl}}, secret {{token}}/{{apiKey}}/{{password}}, :userId-style path variables, and reuses variables whose values already appear; you pick what to apply and where new variables go.
4. Collections under collections
   → Done as workspaces: a level above collections that groups collections and environments. Switch from the top bar (each workspace remembers its environment); "Manage workspaces…" to add, rename or remove; move a collection or environment from its ⋯ menu. Globals and history are shared.
5. Automation testing that can UI testing, like for user name and password, fetching of cookies, or auth token from browser cookies and then using it as token it as for the rst of the pipeline for rest calls. Its more like n8n for testing. We can discuss
   → Decided (username/password forms, installed Chrome/Edge, tokens only for now, visual flows wanted). Browser login request type: done. Visual flows: done (canvas editor, `dispatch-run flow`, MCP `run_flow`) on `feature/flows`. UI assertions/screenshots: later, as decided.
6. Can same rest endpoint can have aliases, for ex. a load balancer url, a ingress url, then a actual pod or individual instance url. User can set them as layers in env if needed.
   → Done: an environment variable can have named alternatives (e.g. load balancer, ingress, pod-1). Switch the active one from the top bar, run a collection once per alternative in the Runner, or aim a load test at one.
