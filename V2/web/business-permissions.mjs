// Project the current module grants onto existing connector configuration.
export function integrationAccess(state) {
  const module = state?.modules?.find(item=>item.id === 'integrations')
  const read = state?.settings?.ai_enabled === true && module?.available === true && module?.permissions?.ai_read === true
  return {read,write:read && module?.permissions?.ai_write === true}
}

export function connectorConfig(config, state) {
  if (integrationAccess(state).read) return {...config}
  return {...config,NOTION_TOKEN:'',YOUTUBE_API_KEY:'',YOUTUBE_ACCESS_TOKEN:'',
    YOUTUBE_CLIENT_ID:'',YOUTUBE_CLIENT_SECRET:'',NOTION_CLIENT_ID:'',NOTION_CLIENT_SECRET:''}
}
