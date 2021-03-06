module.exports = (state, complete) => {

  const Table        = require('ascii-table'),
        async        = require('async'),
        bn           = require('bignumber.js'),

        util         = require('../../utilities'),
        query        = require('../../queries')

  let   index        = 0,
        cache        = [],
        table,
        uniques

  const init = (address, finished) => {
    let Wallet = require('../../classes/Wallet.Testnet')
    let wallet = new Wallet( address, state.config )
    finished( null, wallet )
  }

  const key = (wallet, finished) => {
    query.last_register(wallet.address, state.block_begin, state.block_end, eos_key => {
      wallet.eos_key = eos_key
      finished( null, wallet )
    })
  }

  const transfers = (wallet, finished) => {
    wallet.transfers = []

    const add = next => {
      query.address_transfers_in(wallet.address, state.block_begin, state.block_end)
        .then( results => {
          let _results = results.map( result => new bn(result.dataValues.eos_amount) )
          wallet.transfers = wallet.transfers.concat(_results)
          next()
        })
    }

    const subtract = next => {
      query.address_transfers_out(wallet.address, state.block_begin, state.block_end)
        .then( results => {
          let _results = results.map( result => new bn(result.dataValues.eos_amount).times(-1) )
          wallet.transfers = wallet.transfers.concat(_results)
          next()
        })
    }

    async.series([
      add,
      subtract
    ], () => { finished( null, wallet ) })
  }

  const claims = (wallet, finished) => {
    // console.log('Wallet Claims')
    query.address_claims(wallet.address, state.block_begin, state.block_end)
      .then( results => {
        wallet.claims = new Array( CS_NUMBER_OF_PERIODS ).fill( false )
        results.forEach( result => {
          wallet.claims[ result.dataValues.period ] = true
        })
        finished( null, wallet )
      })
  }

  const buys = ( wallet, finished ) => {
    query.address_buys(wallet.address, state.block_begin, state.block_end)
      .then( results => {
        wallet.buys = new Array( CS_NUMBER_OF_PERIODS ).fill( new bn(0) )
        results.forEach( result => {
          wallet.buys[ result.dataValues.period ] = wallet.buys[ result.dataValues.period ].plus( new bn(result.dataValues.eth_amount) )
        })
        finished( null, wallet )
      })
  }

  const reclaimables = ( wallet, finished ) => {
    query.address_reclaimables( wallet.address, state.block_begin, state.block_end )
      .then( results  => {
        if( results.length ) {
          wallet.reclaimables = results.map( reclaim => { return { address: wallet.address, value: reclaim.dataValues.eos_amount } } )
        }
        finished( null, wallet )
      })
  }

  const processing = ( wallet, finished ) => {
    wallet.process( json => {
      log_table_row( wallet )
      cache.push( json )
      finished( null, wallet )
    })
  }

  const save_or_continue = (next_address, finished = false) => {
    if(cache.length >= 50 || cache.length == state.total || finished )
      query.wallets_bulk_upsert( cache )
        .then( () => {
          cache = new Array()
          log_table_render_and_reset()
          next_address()
        })
    else
      next_address()
  }

  const setup = () => {
    cache = new Array()
    state.total = 0
  }

  const log_table_reset = () => {
    table = new Table(`${Math.round(index*50/uniques.size*100)}% [${index*50}/${uniques.size}] `)
    table.setHeading('V', 'R', 'ETH', 'EOS', 'In Wallet', 'Unclaimed', 'Reclaimed', 'Total', 'Reg. Error')
  }

  const log_table_render_and_reset = () => {
    index++
    console.log(table.render())
    log_table_reset()
  }

  const log_table_row = (wallet) => {
    table.addRow(
      (wallet.accepted ? `✓` : ` `),
      (wallet.registered ? `✓` : ` `),
      wallet.address,
      wallet.eos_key,
      `${wallet.balance.wallet} EOS`,
      `${wallet.balance.unclaimed} EOS`,
      `${wallet.balance.reclaimed} EOS`,
      `${wallet.balance.total} EOS`,
      `${wallet.register_error ? wallet.register_error : ""}`
    )
  }

  console.log('Syncing Wallets')
  query.address_uniques( state.block_begin, state.block_end, _uniques => {
      uniques     = new Set(_uniques)
      state.total = uniques.size

      log_table_reset()

      async.eachSeries( Array.from(uniques), (address, next_address) => {
        async.waterfall([
          (next)         => init(address, next),
          (wallet, next) => key(wallet, next),
          (wallet, next) => buys(wallet, next),
          (wallet, next) => claims(wallet, next),
          (wallet, next) => transfers(wallet, next),
          (wallet, next) => reclaimables(wallet, next),
          (wallet, next) => processing(wallet, next)
        ],
        (error, wallet) => save_or_continue(next_address))
      },
      (err, result) => {
        save_or_continue( () => { complete( null, state ) }, true )
      })
  })
}
