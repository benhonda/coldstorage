import { type RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// The fs-routes foundation: the app/routes/ file tree becomes RR7 routes here.
// generouted sits on top purely as a type layer (app/lib/router/routes.ts, generated).
export default flatRoutes() satisfies RouteConfig;
