function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

function portOf(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

export function isCosmicUnityDevice(device) {
  if (device?.deviceType === 'CosmicUnity') return true
  const port = portOf(device?.port ?? device?.oscQueryPort)
  return device?.isLocal === true && port >= 5001 && port <= 5016
}

export function isAndroidDevice(device) {
  if (isCosmicUnityDevice(device)) return false
  return device?.deviceType === 'Android' || /android/i.test(device?.name || '')
}

function serviceAddresses(service) {
  return new Set(
    [service?.address, service?.host, ...(service?.addresses || [])]
      .map(normalized)
      .filter(Boolean)
  )
}

function deviceEndpoints(device) {
  const endpoints = [...(device?.endpoints || [])]
  if (device?.activeEndpoint) endpoints.push(device.activeEndpoint)
  if (device?.host && (device?.port || device?.oscQueryPort)) {
    endpoints.push({
      host: device.host,
      port: device.port || device.oscQueryPort
    })
  }
  return endpoints
}

export function serviceMatchesDevice(service, device) {
  if (!service || !device) return false

  const serviceFqdn = normalized(service.fqdn)
  const servicePort = portOf(service.port)
  const addresses = serviceAddresses(service)

  return deviceEndpoints(device).some((endpoint) => {
    const endpointFqdn = normalized(endpoint?.fqdn)
    if (serviceFqdn && endpointFqdn && serviceFqdn === endpointFqdn) return true

    const endpointPort = portOf(endpoint?.port)
    const endpointHost = normalized(endpoint?.host)
    return servicePort != null &&
      endpointPort === servicePort &&
      endpointHost &&
      addresses.has(endpointHost)
  })
}

function serviceDeclaresAndroid(service) {
  const txt = service?.txt || {}
  const declaredType = normalized(
    service?.deviceType || txt.device_type || txt.deviceType || txt.DEVICE_TYPE
  )
  return declaredType === 'android' || /android/i.test(service?.name || '')
}

export function filterLinkTargetServices(sourceDevice, services, registryDevices) {
  const availableServices = Array.isArray(services) ? services : []
  if (!isCosmicUnityDevice(sourceDevice)) return availableServices

  const androidDevices = (Array.isArray(registryDevices) ? registryDevices : [])
    .filter(isAndroidDevice)

  return availableServices.filter((service) => {
    if (serviceDeclaresAndroid(service)) return true
    return androidDevices.some((device) => serviceMatchesDevice(service, device))
  })
}
