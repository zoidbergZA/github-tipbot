import React, { useState, useEffect, useContext } from 'react';
import { makeStyles } from '@material-ui/core';
import Moment from 'react-moment';
import { combineLatest } from 'rxjs';
import { mergeAll } from 'rxjs/operators';
import app from '../../base';
import { collectionData } from 'rxfire/firestore';
import { AuthContext } from 'contexts/Auth';
import Transaction from './Transaction/Transaction';
import Heading from 'react-bulma-components/lib/components/heading';
import Container from 'react-bulma-components/lib/components/container';
import Section from 'react-bulma-components/lib/components/section';
import Spinner from '../Spinner/Spinner';

const useStyles = makeStyles({
  txItem: {
    marginTop: '15px'
  }
});

const History = () => {
  const { currentUser } = useContext(AuthContext);
  const [transactions, setTransactions] = useState(null);
  const classes = useStyles();

  useEffect(() => {
    if (currentUser && currentUser.primaryAccountId) {
      collectionData(
        app.firestore()
        .collection(`users/${currentUser.uid}/turtle_accounts`)
      ).subscribe(accs => {
        const streams = accs.map(acc => {
          return collectionData(
            app.firestore().collection(`accounts/${acc.accountId}/transactions`)
            .orderBy('timestamp', 'desc')
            .limit(40)
          );
        });

        combineLatest(streams).pipe(mergeAll()).subscribe(txs => {
          setTransactions(txs);
        });
      });
    }
  }, [currentUser]);

  let history;

  if (transactions) {
    const items = [];

    for (const [index, tx] of transactions.entries()) {
      if (index === 0) {
        items.push(<Moment unix key={index} format="MMMM D, YYYY">{tx.timestamp / 1000}</Moment>);
      } else {
        const prevTxDay = new Date(transactions[index-1].timestamp).getDay();
        const thisTxDay = new Date(tx.timestamp).getDay();

        if (prevTxDay !== thisTxDay) {
          items.push(<Moment unix key={index} format="MMMM D, YYYY">{tx.timestamp / 1000}</Moment>);
        }
      }

      items.push((
        <div className={classes.txItem} key={tx.id}>
          <Transaction tx={tx}/>
        </div>
      ));
    }

    history = items;
  } else {
    history = <Spinner/>
  }

  return (
    <React.Fragment>
      <Heading>Transaction history</Heading>
      <Section>
        <Container>
          {history}
        </Container>
      </Section>
    </React.Fragment>
  );
}

export default History;