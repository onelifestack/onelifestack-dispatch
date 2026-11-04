1. MCP support
   → Planned (both): an MCP request type to test MCP servers, and `dispatch-run mcp` so AI assistants can run your collections.
2. Duplicate environment
   → Done: "Duplicate" in the environment editor and the environment's ⋯ menu (values included).
3. Smart conversion of http request into paramertized that use environments and variables
   → Next.
4. Collections under collections
   → Planned as workspaces: a level above collections that groups collections and environments, with a switcher.
5. Automation testing that can UI testing, like for user name and password, fetching of cookies, or auth token from browser cookies and then using it as token it as for the rst of the pipeline for rest calls. Its more like n8n for testing. We can discuss
   → Design doc first (docs/design/browser-automation.md), nothing built yet.
6. Can same rest endpoint can have aliases, for ex. a load balancer url, a ingress url, then a actual pod or individual instance url. User can set them as layers in env if needed.
   → Planned.
