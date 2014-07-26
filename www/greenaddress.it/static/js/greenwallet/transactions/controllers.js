angular.module('greenWalletTransactionsControllers',
    ['greenWalletServices'])
.controller('TransactionsController', ['$scope', 'wallets', 'tx_sender', 'notices', 'branches', '$modal', 'gaEvent', '$timeout', '$q', 'encode_key', 'hostname',
        function TransactionsController($scope, wallets, tx_sender, notices, branches, $modal, gaEvent, $timeout, $q, encode_key, hostname) {
    // required already by InfoController
    // if(!wallets.requireWallet($scope)) return;

    var limiter = {
        cur_limit: ['10'],
        redo: function() {
            if (this.cur_limit[0] == '10') this.last10();
            else if (this.cur_limit[0] == 'months') this.lastnmonths(this.cur_limit[1]);
            else if (this.cur_limit[0] == 'all') this.all();
        },
        last10: function() {
            $scope.wallet.transactions.limit = 10;
            $scope.wallet.transactions.populate_csv();
            this.cur_limit = ['10'];
        },
        lastnmonths: function(n) {
            $scope.wallet.transactions.limit = $scope.wallet.transactions.list.length;
            // find first tx older than n months and exclude it with all further txs
            for (var i = 0; i < $scope.wallet.transactions.limit; i++) {
                if ((new Date() - $scope.wallet.transactions.list[i].ts) > n*30*24*60*60*1000) {
                    $scope.wallet.transactions.limit = i;
                    break;
                }
            }
            $scope.wallet.transactions.populate_csv();
            this.cur_limit = ['months', n];
        },
        all: function() {
            $scope.wallet.transactions.limit = $scope.wallet.transactions.list.length;
            $scope.wallet.transactions.populate_csv();
            this.cur_limit = ['all'];
        }
    }
    $scope.$watch('wallet.transactions', function(newValue, oldValue) {
        if (!$scope.wallet.transactions) return;
        $scope.wallet.transactions.limiter = limiter;
        limiter.redo();
    });

    var _redeem = function(transaction) {
        gaEvent('Wallet', 'TransactionsTabRedeem');
        var key = tx_sender.hdwallet;
        key = $q.when(key.derivePrivate(branches.EXTERNAL));
        key = key.then(function(key) {
            return key.derivePrivate(transaction.pubkey_pointer);
        });
        return key.then(function(key) {
            return tx_sender.call("http://greenaddressit.com/vault/prepare_sweep_social",
                    key.pub.toBytes(), false).then(function(data) {
                data.prev_outputs = [];
                for (var i = 0; i < data.prevout_scripts.length; i++) {
                    data.prev_outputs.push(
                        {branch: branches.EXTERNAL, pointer: transaction.pubkey_pointer,
                         script: data.prevout_scripts[i]})
                }
                // TODO: verify
                return wallets.sign_and_send_tx(undefined, data, true);  // priv_der=true
            }, function(error) {
                gaEvent('Wallet', 'TransactionsTabRedeemFailed', error.desc);
                notices.makeNotice('error', error.desc);
                return $q.reject(error);
            });
        });
    };
    $scope.redeem = function(transaction) {
        $scope.redeem_transaction = transaction;
        $scope._redeem = function() {
            $scope.redeeming = true;
            _redeem(transaction).then(modal.close).finally(function() {
                $scope.redeeming = false;
            });
        }
        var modal = $modal.open({
            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_tx_redeem.html',
            scope: $scope
        });
    }
    $scope.generate_nlocktime = function(transaction, output) {
        wallets.get_two_factor_code($scope).then(function(twofactor_data) {
            tx_sender.call("http://greenaddressit.com/vault/prepare_nlocktime",
                [[transaction.txhash, output.pt_idx]], twofactor_data).then(function(data) {
                    // TODO: verify
                    var tx = Bitcoin.Transaction.deserialize(data.tx);
                    var signatures = [];
                    var ins = [output];
                    for (var i = 0; i < ins.length; ++i) {
                        var out = ins[i];
                        var in_ = tx.ins[i];
                        var key = tx_sender.hdwallet;
                        key = key.derive(branches.REGULAR);
                        key = key.derive(out.pubkey_pointer);
                        key = key.priv;
                        var script = new Bitcoin.Script(in_.script.chunks[3]);
                        var SIGHASH_ALL = 1;
                        var sign = key.sign(tx.hashTransactionForSignature(script, i, SIGHASH_ALL));
                        sign.push(SIGHASH_ALL);

                        var in_script = new Bitcoin.Script();
                        in_script.writeOp(0);
                        in_script.writeBytes(in_.script.chunks[1]);  // ga sig
                        in_script.writeBytes(sign);  // user's sig
                        in_script.writeBytes(in_.script.chunks[3]);  // 2of2 outscript
                        in_.script = in_script;

                        data.tx = Bitcoin.convert.bytesToHex(tx.serialize());
                    }
                    output.nlocktime_json = JSON.stringify(data);
            }, function(error) {
                notices.makeNotice('error', error.desc);
            });
        });
    };

    $scope.details = function(transaction) {
        gaEvent('Wallet', 'TransactionsTabDetailsModal');
        $scope.selected_transaction = transaction;
        if (transaction.has_payment_request && !transaction.payment_request) {
            tx_sender.call('http://greenaddressit.com/txs/get_payment_request', transaction.txhash).then(function(payreq_b64) {
                transaction.payment_request = 'data:application/bitcoin-paymentrequest;base64,' + payreq_b64;
            });
        }
        $modal.open({
            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_tx_details.html',
            scope: $scope
        })
    };

    $scope.show_voucher = function(transaction, passphrase) {
        return $q.when($scope.wallet.hdwallet.derivePrivate(branches.EXTERNAL)).then(function(key) {
            return $q.when(key.derivePrivate(transaction.pubkey_pointer)).then(function(key) {
                return encode_key(key, passphrase).then(function(enckey) {
                    $scope.voucher = {
                        encrypted: !!passphrase,
                        enckey: enckey,
                        satoshis: transaction.social_value,
                        url: 'https://' + hostname + '/redeem/?amount=' + transaction.social_value + '#/redeem/' + enckey,
                        text: transaction.social_destination.text
                    };
                    $modal.open({
                        templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_voucher.html',
                        scope: $scope
                    });
                });
            });
        });
    };

    $scope.show_encrypted_voucher = function(transaction) {
        $scope.encrypting_voucher = true;
        $scope.encrypt_password_modal = {
            encrypt: function() {
                this.error = undefined;
                if (!this.password) {
                    this.error = gettext('Please provide a password.');
                    return;
                }
                if (this.password != this.password_repeated) {
                    this.error = gettext('Passwords do not match.');
                    return;
                }
                var that = this;
                this.encrypting = true;
                $scope.show_voucher(transaction, this.password).then(function() {
                    that.encrypting = false;
                    modal.close();
                });
            }
        }
        var modal = $modal.open({
            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/signuplogin/modal_encryption_password.html',
            scope: $scope
        });
    };

}]);