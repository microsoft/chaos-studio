# Supported Chaos Studio Scenario catalog

Prefer the exact versioned Scenario names returned by:

`chaos_list_recommended_scenarios` in the bundled `chaos-studio` MCP server.

Scenario recommendations are public preview. A hypothesis is eligible only when
the discovered target resources satisfy the Scenario's requirements. A custom
Scenario is eligible only when every Action is currently supported and the
configuration already validates. Never invent a fault.

| Scenario family | Action | Eligible targets |
|---|---|---|
| DNS Outage | Block outbound port 53 with an NSG rule | NSG, Virtual Network |
| Microsoft Entra ID Outage | Block Entra ID endpoints with an NSG rule | NSG, Virtual Network |
| Compute Zone Down | Shut down VM/VMSS instances in one zone | Virtual Machines, VMSS |
| Zone Down | VMSS zone shutdown and Azure Cache for Redis failover | VMSS, Azure Cache for Redis |
| Compute Zone Down + PostgreSQL Failover | Zone shutdown and PostgreSQL flexible-server failover | VM, VMSS, PostgreSQL flexible server |
| Compute Zone Down + SQL DB Failover | Zone shutdown and SQL Database geo-failover | VM, VMSS, Azure SQL Database |
| Compute Zone Down + SQL MI Failover | Zone shutdown and SQL MI failover | VM, VMSS, SQL Managed Instance |
| DB Failover Under Load | MySQL failover during Azure Load Testing | MySQL flexible server, Azure Load Testing |
| DB Restart Under Load | MySQL restart during Azure Load Testing | MySQL flexible server, Azure Load Testing |
| Cache Stampede | Flush Managed Redis, restart MySQL and App Service | Managed Redis, MySQL flexible server, App Service |
| Cache Stampede with Process Crash | Flush Redis, restart MySQL, kill App Service process | Same as above; Windows App Service only |
| Event-Driven Messaging Disruption | Disable Service Bus queues and Event Hubs entities | Service Bus, Event Hubs |
| Dependency Blackout | Block Key Vault and disable Service Bus/Event Hubs | NSG, Service Bus, Event Hubs |
| VM Hibernate | Hibernate and restore standalone VMs | Virtual Machines |
| CPU Pressure | Agent-based sustained CPU stress | Standalone Virtual Machines |
| Physical Memory Pressure | Agent-based memory stress | Standalone Virtual Machines |

Typical mappings include cache coalescing risk to Cache Stampede, missing
messaging backpressure/DLQ behavior to Event-Driven Messaging Disruption,
single-zone posture to Compute Zone Down, DNS/identity fallback gaps to their
outage Scenarios, and standalone VM capacity risk to CPU or memory pressure.
Applicability remains a gate, not a hint.
