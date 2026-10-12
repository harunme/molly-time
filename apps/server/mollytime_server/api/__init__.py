"""REST endpoints under `/api/*`.

Auth flow:
  POST /api/auth/login   {username, password}   → {accessToken, refreshToken, user, family}
  POST /api/auth/refresh {refreshToken}          → {accessToken, refreshToken}
  POST /api/auth/logout  {refreshToken}          → {ok}

Identity & family:
  GET  /api/me                                     → {user, family}
  GET  /api/families/me/children                   → [{id, name, avatarUrl}]
  POST /api/children/{id}/select    (sets current child in token claim later)

Catalog:
  GET  /api/home                                   → {rows: [{title, items: [{...}]}]}
  GET  /api/series/{id}                            → {series, seasons}
  GET  /api/seasons/{id}                           → {season, episodes}
  GET  /api/episodes/{id}                          → {episode, mediaSources}

Playback:
  GET  /api/episodes/{id}/play?token=...           → 302 to media URL or direct stream
  POST /api/episodes/{id}/progress  {positionMs, ...} → {ok}
  GET  /api/subtitles/{episodeId}/{index}.{ext}    → subtitle bytes
  GET  /api/images/{itemId}?w=&h=                  → image bytes
"""