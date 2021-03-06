/*
Copyright 2017 Vector Creations Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';

import url from 'url';
import qs from 'querystring';
import React from 'react';
import MatrixClientPeg from '../../../MatrixClientPeg';
import PlatformPeg from '../../../PlatformPeg';
import ScalarAuthClient from '../../../ScalarAuthClient';
import SdkConfig from '../../../SdkConfig';
import Modal from '../../../Modal';
import { _t, _td } from '../../../languageHandler';
import sdk from '../../../index';
import AppPermission from './AppPermission';
import AppWarning from './AppWarning';
import MessageSpinner from './MessageSpinner';
import WidgetUtils from '../../../WidgetUtils';
import dis from '../../../dispatcher';

const ALLOWED_APP_URL_SCHEMES = ['https:', 'http:'];

export default React.createClass({
    displayName: 'AppTile',

    propTypes: {
        id: React.PropTypes.string.isRequired,
        url: React.PropTypes.string.isRequired,
        name: React.PropTypes.string.isRequired,
        room: React.PropTypes.object.isRequired,
        type: React.PropTypes.string.isRequired,
        // Specifying 'fullWidth' as true will render the app tile to fill the width of the app drawer continer.
        // This should be set to true when there is only one widget in the app drawer, otherwise it should be false.
        fullWidth: React.PropTypes.bool,
        // UserId of the current user
        userId: React.PropTypes.string.isRequired,
        // UserId of the entity that added / modified the widget
        creatorUserId: React.PropTypes.string,
    },

    getDefaultProps() {
        return {
            url: "",
        };
    },

    /**
     * Set initial component state when the App wUrl (widget URL) is being updated.
     * Component props *must* be passed (rather than relying on this.props).
     * @param  {Object} newProps The new properties of the component
     * @return {Object} Updated component state to be set with setState
     */
    _getNewState(newProps) {
        const widgetPermissionId = [newProps.room.roomId, encodeURIComponent(newProps.url)].join('_');
        const hasPermissionToLoad = localStorage.getItem(widgetPermissionId);
        return {
            initialising: true,   // True while we are mangling the widget URL
            loading: true,        // True while the iframe content is loading
            widgetUrl: newProps.url,
            widgetPermissionId: widgetPermissionId,
            // Assume that widget has permission to load if we are the user who
            // added it to the room, or if explicitly granted by the user
            hasPermissionToLoad: hasPermissionToLoad === 'true' || newProps.userId === newProps.creatorUserId,
            error: null,
            deleting: false,
        };
    },

    getInitialState() {
        return this._getNewState(this.props);
    },

    /**
     * Returns true if specified url is a scalar URL, typically https://scalar.vector.im/api
     * @param  {[type]}  url URL to check
     * @return {Boolean} True if specified URL is a scalar URL
     */
    isScalarUrl(url) {
        if (!url) {
            console.error('Scalar URL check failed. No URL specified');
            return false;
        }

        let scalarUrls = SdkConfig.get().integrations_widgets_urls;
        if (!scalarUrls || scalarUrls.length == 0) {
            scalarUrls = [SdkConfig.get().integrations_rest_url];
        }

        for (let i = 0; i < scalarUrls.length; i++) {
            if (url.startsWith(scalarUrls[i])) {
                return true;
            }
        }
        return false;
    },

    isMixedContent() {
        const parentContentProtocol = window.location.protocol;
        const u = url.parse(this.props.url);
        const childContentProtocol = u.protocol;
        if (parentContentProtocol === 'https:' && childContentProtocol !== 'https:') {
            console.warn("Refusing to load mixed-content app:",
            parentContentProtocol, childContentProtocol, window.location, this.props.url);
            return true;
        }
        return false;
    },

    componentWillMount() {
        window.addEventListener('message', this._onMessage, false);
        this.setScalarToken();
    },

    /**
     * Adds a scalar token to the widget URL, if required
     * Component initialisation is only complete when this function has resolved
     */
    setScalarToken() {
        this.setState({initialising: true});

        if (!this.isScalarUrl(this.props.url)) {
            console.warn('Non-scalar widget, not setting scalar token!', url);
            this.setState({
                error: null,
                widgetUrl: this.props.url,
                initialising: false,
            });
            return;
        }

        // Fetch the token before loading the iframe as we need it to mangle the URL
        if (!this._scalarClient) {
            this._scalarClient = new ScalarAuthClient();
        }
        this._scalarClient.getScalarToken().done((token) => {
            // Append scalar_token as a query param if not already present
            this._scalarClient.scalarToken = token;
            const u = url.parse(this.props.url);
            const params = qs.parse(u.query);
            if (!params.scalar_token) {
                params.scalar_token = encodeURIComponent(token);
                // u.search must be set to undefined, so that u.format() uses query paramerters - https://nodejs.org/docs/latest/api/url.html#url_url_format_url_options
                u.search = undefined;
                u.query = params;
            }

            this.setState({
                error: null,
                widgetUrl: u.format(),
                initialising: false,
            });
        }, (err) => {
            console.error("Failed to get scalar_token", err);
            this.setState({
                error: err.message,
                initialising: false,
            });
        });
    },

    componentWillUnmount() {
        window.removeEventListener('message', this._onMessage);
    },

    componentWillReceiveProps(nextProps) {
        if (nextProps.url !== this.props.url) {
            this._getNewState(nextProps);
            this.setScalarToken();
        } else if (nextProps.show && !this.props.show) {
            this.setState({
                loading: true,
            });
        }
    },

    _onMessage(event) {
        if (this.props.type !== 'jitsi') {
            return;
        }
        if (!event.origin) {
            event.origin = event.originalEvent.origin;
        }

        if (!this.state.widgetUrl.startsWith(event.origin)) {
            return;
        }

        if (event.data.widgetAction === 'jitsi_iframe_loaded') {
            const iframe = this.refs.appFrame.contentWindow
                .document.querySelector('iframe[id^="jitsiConferenceFrame"]');
            PlatformPeg.get().setupScreenSharingForIframe(iframe);
        }
    },

    _canUserModify() {
        return WidgetUtils.canUserModifyWidgets(this.props.room.roomId);
    },

    _onEditClick(e) {
        console.log("Edit widget ID ", this.props.id);
        const IntegrationsManager = sdk.getComponent("views.settings.IntegrationsManager");
        const src = this._scalarClient.getScalarInterfaceUrlForRoom(
            this.props.room.roomId, 'type_' + this.props.type, this.props.id);
        Modal.createTrackedDialog('Integrations Manager', '', IntegrationsManager, {
            src: src,
        }, "mx_IntegrationsManager");
    },

    /* If user has permission to modify widgets, delete the widget,
     * otherwise revoke access for the widget to load in the user's browser
    */
    _onDeleteClick() {
        if (this._canUserModify()) {
            // Show delete confirmation dialog
            const QuestionDialog = sdk.getComponent("dialogs.QuestionDialog");
            Modal.createTrackedDialog('Delete Widget', '', QuestionDialog, {
                title: _t("Delete Widget"),
                description: _t(
                    "Deleting a widget removes it for all users in this room." +
                    " Are you sure you want to delete this widget?"),
                button: _t("Delete widget"),
                onFinished: (confirmed) => {
                    if (!confirmed) {
                        return;
                    }
                    this.setState({deleting: true});
                    MatrixClientPeg.get().sendStateEvent(
                        this.props.room.roomId,
                        'im.vector.modular.widgets',
                        {}, // empty content
                        this.props.id,
                    ).catch((e) => {
                        console.error('Failed to delete widget', e);
                        this.setState({deleting: false});
                    });
                },
            });
        } else {
            console.log("Revoke widget permissions - %s", this.props.id);
            this._revokeWidgetPermission();
        }
    },

    _onLoaded() {
        this.setState({loading: false});
    },

    // Widget labels to render, depending upon user permissions
    // These strings are translated at the point that they are inserted in to the DOM, in the render method
    _deleteWidgetLabel() {
        if (this._canUserModify()) {
            return _td('Delete widget');
        }
        return _td('Revoke widget access');
    },

    /* TODO -- Store permission in account data so that it is persisted across multiple devices */
    _grantWidgetPermission() {
        console.warn('Granting permission to load widget - ', this.state.widgetUrl);
        localStorage.setItem(this.state.widgetPermissionId, true);
        this.setState({hasPermissionToLoad: true});
    },

    _revokeWidgetPermission() {
        console.warn('Revoking permission to load widget - ', this.state.widgetUrl);
        localStorage.removeItem(this.state.widgetPermissionId);
        this.setState({hasPermissionToLoad: false});
    },

    formatAppTileName() {
        let appTileName = "No name";
        if(this.props.name && this.props.name.trim()) {
            appTileName = this.props.name.trim();
        }
        return appTileName;
    },

    onClickMenuBar(ev) {
        ev.preventDefault();

        // Ignore clicks on menu bar children
        if (ev.target !== this.refs.menu_bar) {
            return;
        }

        // Toggle the view state of the apps drawer
        dis.dispatch({
            action: 'appsDrawer',
            show: !this.props.show,
        });
    },

    render() {
        let appTileBody;

        // Don't render widget if it is in the process of being deleted
        if (this.state.deleting) {
            return <div></div>;
        }

        // Note that there is advice saying allow-scripts shouldn't be used with allow-same-origin
        // because that would allow the iframe to prgramatically remove the sandbox attribute, but
        // this would only be for content hosted on the same origin as the riot client: anything
        // hosted on the same origin as the client will get the same access as if you clicked
        // a link to it.
        const sandboxFlags = "allow-forms allow-popups allow-popups-to-escape-sandbox "+
            "allow-same-origin allow-scripts allow-presentation";
        const parsedWidgetUrl = url.parse(this.state.widgetUrl);
        let safeWidgetUrl = '';
        if (ALLOWED_APP_URL_SCHEMES.indexOf(parsedWidgetUrl.protocol) !== -1) {
            safeWidgetUrl = url.format(parsedWidgetUrl);
        }

        if (this.props.show) {
            const loadingElement = (
                <div className='mx_AppTileBody mx_AppLoading'>
                    <MessageSpinner msg='Loading...' />
                </div>
            );
            if (this.state.initialising) {
                appTileBody = loadingElement;
            } else if (this.state.hasPermissionToLoad == true) {
                if (this.isMixedContent()) {
                    appTileBody = (
                        <div className="mx_AppTileBody">
                            <AppWarning errorMsg="Error - Mixed content" />
                        </div>
                    );
                } else {
                    appTileBody = (
                        <div className={this.state.loading ? 'mx_AppTileBody mx_AppLoading' : 'mx_AppTileBody'}>
                            { this.state.loading && loadingElement }
                            <iframe
                                ref="appFrame"
                                src={safeWidgetUrl}
                                allowFullScreen="true"
                                sandbox={sandboxFlags}
                                onLoad={this._onLoaded}
                            ></iframe>
                        </div>
                    );
                }
            } else {
                const isRoomEncrypted = MatrixClientPeg.get().isRoomEncrypted(this.props.room.roomId);
                appTileBody = (
                    <div className="mx_AppTileBody">
                        <AppPermission
                            isRoomEncrypted={isRoomEncrypted}
                            url={this.state.widgetUrl}
                            onPermissionGranted={this._grantWidgetPermission}
                        />
                    </div>
                );
            }
        }

        // editing is done in scalar
        const showEditButton = Boolean(this._scalarClient && this._canUserModify());
        const deleteWidgetLabel = this._deleteWidgetLabel();
        let deleteIcon = 'img/cancel.svg';
        let deleteClasses = 'mx_filterFlipColor mx_AppTileMenuBarWidget';
        if(this._canUserModify()) {
            deleteIcon = 'img/icon-delete-pink.svg';
            deleteClasses += ' mx_AppTileMenuBarWidgetDelete';
        }

        return (
            <div className={this.props.fullWidth ? "mx_AppTileFullWidth" : "mx_AppTile"} id={this.props.id}>
                <div ref="menu_bar" className="mx_AppTileMenuBar" onClick={this.onClickMenuBar}>
                    { this.formatAppTileName() }
                    <span className="mx_AppTileMenuBarWidgets">
                        { /* Edit widget */ }
                        { showEditButton && <img
                            src="img/edit.svg"
                            className="mx_filterFlipColor mx_AppTileMenuBarWidget mx_AppTileMenuBarWidgetPadding"
                            width="8" height="8"
                            alt={_t('Edit')}
                            title={_t('Edit')}
                            onClick={this._onEditClick}
                        /> }

                        { /* Delete widget */ }
                        <img src={deleteIcon}
                        className={deleteClasses}
                        width="8" height="8"
                        alt={_t(deleteWidgetLabel)}
                        title={_t(deleteWidgetLabel)}
                        onClick={this._onDeleteClick}
                        />
                    </span>
                </div>
                { appTileBody }
            </div>
        );
    },
});
