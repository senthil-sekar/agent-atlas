param prefix string = 'contoso-q2b'
param location string = resourceGroup().location

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
}

resource quoteApi 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-quote-api'
  location: location
  properties: {
    managedEnvironmentId: env.id
    template: {
      containers: [
        {
          name: 'quote-api'
          image: 'contoso.azurecr.io/quote-api:latest'
          env: [
            { name: 'ConnectionStrings__QuoteDb', value: 'Server=sql;Database=${quoteDb.name}' }
            { name: 'ConnectionStrings__Redis', value: '${redis.properties.hostName}:6380' }
            { name: 'RatingEngine__BaseUrl', value: 'https://${ratingEngine.properties.configuration.ingress.fqdn}' }
            { name: 'ServiceBus__Topic', value: quoteBound.name }
          ]
        }
      ]
    }
  }
}

resource ratingEngine 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-rating-engine'
  location: location
  properties: {
    managedEnvironmentId: env.id
    template: {
      containers: [
        {
          name: 'rating-engine'
          image: 'contoso.azurecr.io/rating-engine:latest'
          env: [
            { name: 'ConnectionStrings__Redis', value: '${redis.properties.hostName}:6380' }
          ]
        }
      ]
    }
  }
}

resource policyWorker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-policy-worker'
  location: location
  properties: {
    managedEnvironmentId: env.id
    template: {
      containers: [
        {
          name: 'policy-worker'
          image: 'contoso.azurecr.io/policy-worker:latest'
          env: [
            { name: 'ConnectionStrings__PolicyDb', value: 'Server=sql;Database=${policyDb.name}' }
            { name: 'ServiceBus__Topic', value: quoteBound.name }
            { name: 'ServiceBus__Subscription', value: '${quoteBound.name}/policy-worker' }
          ]
        }
      ]
    }
  }
}

resource apim 'Microsoft.ApiManagement/service@2023-05-01-preview' = {
  name: '${prefix}-apim'
  location: location
  sku: { name: 'Consumption', capacity: 0 }
  properties: { publisherEmail: 'platform@contoso.com', publisherName: 'Contoso' }
}

resource sql 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: '${prefix}-sql'
  location: location
}

resource quoteDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sql
  name: 'quote-db'
  location: location
}

resource policyDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sql
  name: 'policy-db'
  location: location
}

resource redis 'Microsoft.Cache/redis@2024-03-01' = {
  name: '${prefix}-redis'
  location: location
  properties: { sku: { name: 'Basic', family: 'C', capacity: 0 } }
}

resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: '${prefix}-sb'
  location: location
}

resource quoteBound 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = {
  parent: sb
  name: 'quote-bound'
}
