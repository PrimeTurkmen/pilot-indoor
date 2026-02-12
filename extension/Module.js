/**
 * PILOT Extension — Indoor Positioning
 * Entry point for the Indoor Positioning module.
 * Tracks people and assets indoors using BLE 6.0 Channel Sounding.
 *
 * @see pilot_extensions/AI_SPECS.md
 * @see pilot_extensions/examples/template-app
 * @see pilot_extensions/examples/airports
 */

Ext.define('Store.indoor-positioning.Module', {
    extend: 'Ext.Component',

    initModule: function () {
        // 1. Create navigation tab (left panel) — Building → Floor → Zone tree + tag search
        var navTab = Ext.create('Store.indoor-positioning.IndoorNavPanel', {});

        // 2. Create main floor plan map panel
        var mainPanel = Ext.create('Store.indoor-positioning.FloorPlanView', {});

        // 3. Link navigation to map (MANDATORY for Pattern 1)
        navTab.map_frame = mainPanel;

        // 4. Register in PILOT interface
        skeleton.navigation.add(navTab);
        skeleton.mapframe.add(mainPanel);

        // 5. Optional: header buttons for quick access, zones, settings
        if (skeleton.header && skeleton.header.insert) {
            skeleton.header.insert(3, Ext.create('Ext.Button', {
                iconCls: 'fa fa-map-marker-alt',
                tooltip: (typeof l === 'function') ? l('Indoor Positioning') : 'Indoor Positioning',
                handler: function () {
                    skeleton.navigation.setActiveItem(navTab);
                    skeleton.mapframe.setActiveItem(mainPanel);
                }
            }));
            skeleton.header.insert(4, Ext.create('Ext.Button', {
                iconCls: 'fa fa-draw-polygon',
                tooltip: (typeof l === 'function') ? l('Zone Manager') : 'Zone Manager',
                handler: function () {
                    var win = Ext.create('Store.indoor-positioning.ZoneManager', {
                        mapPanel: mainPanel
                    });
                    win.show();
                }
            }));
            skeleton.header.insert(5, Ext.create('Ext.Button', {
                iconCls: 'fa fa-cog',
                tooltip: (typeof l === 'function') ? l('Indoor Settings') : 'Indoor Settings',
                handler: function () {
                    var win = Ext.create('Store.indoor-positioning.AdminPanel', {
                        mapPanel: mainPanel
                    });
                    win.show();
                }
            }));
        }

        // 6. Load custom styles
        this.loadStyles();
    },

    loadStyles: function () {
        var cssLink = document.createElement('link');
        cssLink.setAttribute('rel', 'stylesheet');
        cssLink.setAttribute('type', 'text/css');
        cssLink.setAttribute('href', '/store/indoor-positioning/styles.css');
        document.head.appendChild(cssLink);
    }
});
