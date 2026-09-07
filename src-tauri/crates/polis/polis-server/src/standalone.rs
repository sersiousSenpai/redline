// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The standalone server (feature `standalone`): bind the router and guard
//! its writes with a bearer token. What the `polis serve` command runs; a
//! host that merges the router under its own listener never compiles this.
//!
//! The guard is the same three-class decision a host makes over [`ROUTES`]:
//! open and hook-contract routes pass with no credential, writes need the
//! token, and a route the router serves that is not in the table fails
//! closed (a 401, never a silent hole). A non-loopback bind without a token
//! is refused before the socket opens — `serve --listen 0.0.0.0` with no
//! token is a mistake, not a mode.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::json;

use crate::{route_spec, PolisState, RouteClass, ROUTES};

/// The token the writes require. `None` is allowed on loopback only.
#[derive(Debug, Clone, Default)]
pub struct StandaloneAuth {
    pub token: Option<String>,
}

/// Why a request was denied — in the 401 body so a misconfigured caller can
/// self-diagnose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denial {
    UnknownRoute,
    MissingToken { scope: &'static str },
    BadToken,
    /// The install has no token, so no write is possible — configure one.
    NoTokenConfigured { scope: &'static str },
}

impl Denial {
    pub fn message(&self) -> String {
        match self {
            Denial::UnknownRoute => "route is not in the surface table (ROUTES) — new routes must be registered there".to_string(),
            Denial::MissingToken { scope } => format!("this route requires a bearer token (scope `{scope}`): send `Authorization: Bearer <token>`"),
            Denial::BadToken => "bearer token not recognized".to_string(),
            Denial::NoTokenConfigured { scope } => format!("this route requires a bearer token (scope `{scope}`) and this server has none configured — start it with a token to enable writes"),
        }
    }
}

/// Constant-time equality so the token check isn't a timing oracle.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The pure decision: the matched route pattern, the method, the stripped
/// bearer, and the configured token.
pub fn authorize(path: &str, method: &str, bearer: Option<&str>, token: Option<&str>) -> Result<(), Denial> {
    let spec = route_spec(path, method).ok_or(Denial::UnknownRoute)?;
    let scope = match spec.class {
        RouteClass::Open | RouteClass::HookContract => return Ok(()),
        RouteClass::Write(scope) => scope,
    };
    let Some(token) = token else {
        return Err(Denial::NoTokenConfigured { scope });
    };
    let bearer = bearer.ok_or(Denial::MissingToken { scope })?;
    if ct_eq(bearer, token) {
        Ok(())
    } else {
        Err(Denial::BadToken)
    }
}

fn bearer_of(req: &Request) -> Option<String> {
    let header = req.headers().get(axum::http::header::AUTHORIZATION)?;
    let value = header.to_str().ok()?;
    value.strip_prefix("Bearer ").map(|t| t.trim().to_string())
}

/// The middleware: `authorize` over every request that matched a route.
pub async fn require_token(State(auth): State<Arc<StandaloneAuth>>, req: Request, next: Next) -> Response {
    let Some(matched) = req.extensions().get::<MatchedPath>() else {
        return next.run(req).await;
    };
    let path = matched.as_str().to_string();
    let method = req.method().as_str().to_string();
    let bearer = bearer_of(&req);
    match authorize(&path, &method, bearer.as_deref(), auth.token.as_deref()) {
        Ok(()) => next.run(req).await,
        Err(denial) => (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": denial.message() }))).into_response(),
    }
}

/// The served application: the router under the token guard.
pub fn app(state: PolisState, auth: StandaloneAuth) -> Router {
    crate::router::<PolisState>()
        .layer(axum::middleware::from_fn_with_state(Arc::new(auth), require_token))
        .with_state(state)
}

/// Refuse a bind that would expose writes to a network with no credential.
pub fn check_bind(addr: &SocketAddr, auth: &StandaloneAuth) -> Result<(), String> {
    if !addr.ip().is_loopback() && auth.token.is_none() {
        return Err(format!(
            "refusing to listen on {addr} without a token: a non-loopback bind needs `--token` (or the writes are open to the network)"
        ));
    }
    Ok(())
}

/// Bind and serve until the listener dies. The token rule is checked first.
pub async fn serve(addr: SocketAddr, state: PolisState, auth: StandaloneAuth) -> std::io::Result<()> {
    check_bind(&addr, &auth).map_err(|m| std::io::Error::new(std::io::ErrorKind::InvalidInput, m))?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, routes = ROUTES.len(), "polis-server listening");
    axum::serve(listener, app(state, auth)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;
    use axum::body::Body;
    use tower::ServiceExt;

    #[test]
    fn open_and_hook_routes_pass_writes_need_the_token_unknown_fails_closed() {
        let tok = Some("secret");
        assert_eq!(authorize("/v1/memory/tree", "GET", None, tok), Ok(()));
        assert_eq!(authorize("/v1/prompts/ingest", "POST", None, tok), Ok(()));
        assert!(matches!(authorize("/v1/memory/remember", "POST", None, tok), Err(Denial::MissingToken { .. })));
        assert_eq!(authorize("/v1/memory/remember", "POST", Some("wrong"), tok), Err(Denial::BadToken));
        assert_eq!(authorize("/v1/memory/remember", "POST", Some("secret"), tok), Ok(()));
        assert_eq!(authorize("/v1/not/in/table", "GET", Some("secret"), tok), Err(Denial::UnknownRoute));
        assert!(matches!(authorize("/v1/memory/forget", "POST", Some("anything"), None), Err(Denial::NoTokenConfigured { scope: "memory.forget" })));
    }

    #[test]
    fn a_network_bind_without_a_token_is_refused_loopback_is_not() {
        let none = StandaloneAuth::default();
        let some = StandaloneAuth { token: Some("t".into()) };
        assert!(check_bind(&"0.0.0.0:7777".parse().unwrap(), &none).is_err());
        assert!(check_bind(&"127.0.0.1:7777".parse().unwrap(), &none).is_ok());
        assert!(check_bind(&"0.0.0.0:7777".parse().unwrap(), &some).is_ok());
    }

    #[tokio::test]
    async fn the_guard_sits_in_front_of_the_real_router() {
        let app = app(testing::state(), StandaloneAuth { token: Some("secret".into()) });
        let read = axum::http::Request::builder().uri("/v1/memory/verify").body(Body::empty()).unwrap();
        assert_eq!(app.clone().oneshot(read).await.unwrap().status(), StatusCode::OK);
        let write = |auth: Option<&str>| {
            let mut b = axum::http::Request::builder().method("POST").uri("/v1/memory/remember").header("content-type", "application/json");
            if let Some(a) = auth {
                b = b.header("authorization", a);
            }
            b.body(Body::from(r#"{"text":"kept","asUser":true}"#)).unwrap()
        };
        assert_eq!(app.clone().oneshot(write(None)).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert_eq!(app.clone().oneshot(write(Some("Bearer nope"))).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert_eq!(app.clone().oneshot(write(Some("Bearer secret"))).await.unwrap().status(), StatusCode::CREATED);
    }
}
